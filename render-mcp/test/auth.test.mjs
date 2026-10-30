import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import express from 'express';
import {installAuth} from '../auth.mjs';

async function setup(t, overrides={}) {
  const app=express();
  const env={MCP_PUBLIC_URL:'http://127.0.0.1',MCP_OAUTH_CLIENT_SECRET:'c'.repeat(48),MCP_OWNER_PASSWORD:'p'.repeat(48),MCP_OAUTH_SIGNING_KEY:'k'.repeat(48),...overrides};
  const auth=installAuth(app,env);
  app.all('/mcp',(req,res)=>res.json({ok:true,client:req.auth?.clientId}));
  const server=app.listen(0,'127.0.0.1');
  await new Promise(r=>server.once('listening',r));
  t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}`;
  return {base,auth,env};
}
const verifier='verifier'.repeat(8);
const challenge=createHash('sha256').update(verifier).digest('base64url');
const callback='https://chatgpt.com/connector_platform_oauth_redirect';
async function authorize(base, env) {
  const query=new URLSearchParams({client_id:'feishu-gtd-chatgpt',redirect_uri:callback,response_type:'code',code_challenge:challenge,code_challenge_method:'S256',scope:'feishu:tools',resource:'http://127.0.0.1/mcp',state:'csrf-state'});
  const page=await fetch(`${base}/authorize?${query}`);
  assert.equal(page.status,200);
  const html=await page.text();
  assert.ok(!html.includes(env.MCP_OWNER_PASSWORD));
  const flow=html.match(/name="flow" value="([^"]+)"/)[1];
  return {flow,consent:async(password=env.MCP_OWNER_PASSWORD, origin='http://127.0.0.1')=>fetch(`${base}/oauth/consent`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin},body:new URLSearchParams({flow,password}),redirect:'manual'})};
}
const exchange=(base,env,code,extra={})=>fetch(`${base}/token`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:'feishu-gtd-chatgpt',client_secret:env.MCP_OAUTH_CLIENT_SECRET,redirect_uri:callback,code,code_verifier:verifier,resource:'http://127.0.0.1/mcp',...extra})});

test('MCP fails closed without secrets',async t=>{const {base}=await setup(t,{MCP_OWNER_PASSWORD:''});for(const method of ['GET','POST','DELETE']) assert.equal((await fetch(`${base}/mcp`,{method})).status,503);});

test('unauthenticated MCP requests return OAuth challenge; metadata publishes resource and PKCE',async t=>{
  const {base}=await setup(t);
  for(const method of ['GET','POST','DELETE']) {const res=await fetch(`${base}/mcp`,{method});assert.equal(res.status,401);assert.match(res.headers.get('www-authenticate'),/oauth-protected-resource\/mcp/);}
  const metadata=await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(metadata.authorization_response_iss_parameter_supported,true);
  assert.deepEqual(metadata.code_challenge_methods_supported,['S256']);
  assert.equal((await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()).resource,'http://127.0.0.1/mcp');
});

test('OAuth consent, PKCE, replay prevention, refresh across restart and token integrity',async t=>{
  const {base,env}=await setup(t);
  const {consent}=await authorize(base,env);
  assert.equal((await consent(env.MCP_OWNER_PASSWORD,'https://evil.invalid')).status,403);
  assert.equal((await consent('wrong-password')).status,403);
  const result=await consent();assert.equal(result.status,303);
  const redirect=new URL(result.headers.get('location'));
  assert.equal(redirect.searchParams.get('state'),'csrf-state');
  assert.equal(redirect.searchParams.get('iss'),'http://127.0.0.1/');
  const code=redirect.searchParams.get('code');
  assert.equal((await exchange(base,env,code,{client_secret:'wrong'})).status,400);
  assert.equal((await exchange(base,env,code,{code_verifier:'wrong'.repeat(15)})).status,400);
  const tokenResponse=await exchange(base,env,code);assert.equal(tokenResponse.status,200);
  const token=await tokenResponse.json();
  assert.equal((await exchange(base,env,code)).status,400);
  assert.equal((await fetch(`${base}/mcp`,{headers:{authorization:`Bearer ${token.access_token}`}})).status,200);
  assert.equal((await fetch(`${base}/mcp`,{headers:{authorization:`Bearer ${token.refresh_token}`}})).status,401);
  assert.equal((await fetch(`${base}/mcp`,{headers:{authorization:`Bearer ${token.access_token}tampered`}})).status,401);
  const restarted=await setup(t);
  assert.equal((await fetch(`${restarted.base}/mcp`,{headers:{authorization:`Bearer ${token.access_token}`}})).status,200);
  const refreshed=await fetch(`${restarted.base}/token`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:'feishu-gtd-chatgpt',client_secret:env.MCP_OAUTH_CLIENT_SECRET,refresh_token:token.refresh_token})});
  assert.equal(refreshed.status,200);
});

test('rejects foreign redirect/resource, missing secret and password brute force',async t=>{
 const {base,env}=await setup(t);
 const query=new URLSearchParams({client_id:'feishu-gtd-chatgpt',redirect_uri:'https://evil.invalid/callback',response_type:'code',code_challenge:challenge,code_challenge_method:'S256'});
 assert.equal((await fetch(`${base}/authorize?${query}`,{redirect:'manual'})).status,400);
 query.set('redirect_uri',callback);query.set('resource','https://evil.invalid/mcp');
 const rejectedResource=await fetch(`${base}/authorize?${query}`,{redirect:'manual'});
 assert.equal(rejectedResource.status,302);
 assert.equal(new URL(rejectedResource.headers.get('location')).searchParams.get('error'),'invalid_target');
 const {consent}=await authorize(base,env);
 for(let i=0;i<10;i++) assert.equal((await consent('wrong')).status,403);
 assert.equal((await consent()).status,429);
});


test('rejects expired tokens and tokens for another audience or scope',async t=>{
 const {base,env}=await setup(t);
 for(const override of [{exp:1},{aud:'https://evil.invalid/mcp'},{scope:'other'},{cid:'another-client'},{iss:'https://evil.invalid/'}]) {
  const claims=Buffer.from(JSON.stringify({type:'access',iss:'http://127.0.0.1/',aud:'http://127.0.0.1/mcp',cid:'feishu-gtd-chatgpt',scope:'feishu:tools',exp:Math.floor(Date.now()/1000)+60,...override})).toString('base64url');
  const token=`${claims}.${createHmac('sha256',env.MCP_OAUTH_SIGNING_KEY).update(claims).digest('base64url')}`;
  assert.equal((await fetch(`${base}/mcp`,{headers:{authorization:`Bearer ${token}`}})).status,401);
 }
});
