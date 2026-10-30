import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Runs the actual production entrypoint against an isolated upstream fixture.
// No Feishu credentials or user data are used here.
test('production MCP entrypoint preserves reads, write shape and sanitized 403 evidence',async t=>{
 const requests=[];
 let denied=true;
 const upstream=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req) raw+=chunk;
  requests.push({method:req.method,url:req.url,body:raw?JSON.parse(raw):undefined,authorization:req.headers.authorization});
  res.setHeader('content-type','application/json');
  if(req.url.includes('/auth/')) return res.end(JSON.stringify({code:0,tenant_access_token:'fixture-tenant-token',expire:7200}));
  if(req.method==='PUT' && denied){res.writeHead(403,{'x-tt-logid':'fixture-log'});return res.end(JSON.stringify({code:91403,msg:'Forbidden',error:{permission_violations:[{subject:'doc.edit',type:'resource_permission_required'}]}}));}
  const data=req.url.includes('/search')?{items:[{record_id:'record-test',fields:{}}],total:1}: {record:{record_id:'record-test',fields:JSON.parse(raw||'{}').fields}};
  res.end(JSON.stringify({code:0,data}));
 });
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');t.after(()=>upstream.close());
 const reservation=http.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 const env={...process.env,PORT:String(port),LARK_DOMAIN:`http://127.0.0.1:${upstream.address().port}`,APP_ID:'fixture-app',APP_SECRET:'fixture-app-secret',USER_ACCESS_TOKEN:'',MCP_PUBLIC_URL:`http://127.0.0.1:${port}`,MCP_OAUTH_CLIENT_SECRET:'c'.repeat(48),MCP_OWNER_PASSWORD:'p'.repeat(48),MCP_OAUTH_SIGNING_KEY:'k'.repeat(48)};
 const {createHmac}=await import('node:crypto');
 const claims=Buffer.from(JSON.stringify({type:'access',iss:`http://127.0.0.1:${port}/`,aud:`http://127.0.0.1:${port}/mcp`,cid:'feishu-gtd-chatgpt',scope:'feishu:tools',exp:Math.floor(Date.now()/1000)+60})).toString('base64url');
 const access=`${claims}.${createHmac('sha256',env.MCP_OAUTH_SIGNING_KEY).update(claims).digest('base64url')}`;
 let logs='';
 const child=spawn(process.execPath,['server-compat.mjs'],{cwd:new URL('..',import.meta.url),env,stdio:['ignore','pipe','pipe']});
 t.after(()=>child.kill());
 child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Server did not start')),5000);child.stdout.on('data',d=>{if(String(d).includes('listening')){clearTimeout(timer);resolve();}});child.once('exit',()=>{clearTimeout(timer);reject(new Error('Server exited'));});});
 const transport=new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),{requestInit:{headers:{authorization:`Bearer ${access}`}}});
 const client=new Client({name:'fixture-test',version:'1'});
 await client.connect(transport);t.after(()=>client.close());
 const path={app_token:'app-test',table_id:'table-test'};
 const read=await client.callTool({name:'bitable_v1_appTableRecord_search',arguments:{path,data:{}}});assert.ok(!read.isError);assert.equal(JSON.parse(read.content[0].text).total,1);
 const update=await client.callTool({name:'bitable_v1_appTableRecord_update',arguments:{path:{...path,record_id:'record-test'},data:{fields:{'文本':'fixture'}}}});
 assert.equal(update.isError,true);const diagnostic=JSON.parse(update.content[0].text);assert.equal(diagnostic.http_status,403);assert.equal(diagnostic.code,91403);assert.equal(diagnostic.log_id,'fixture-log');assert.equal(diagnostic.request.method,'PUT');
 assert.equal(requests.at(-1).url,'/open-apis/bitable/v1/apps/app-test/tables/table-test/records/record-test');
 assert.deepEqual(requests.at(-1).body,{fields:{'文本':'fixture'}});assert.equal(requests.at(-1).authorization,'Bearer fixture-tenant-token');
 denied=false;
 for(const [name,fields] of [['bitable_v1_appTableRecord_update',{'文本':null}],['bitable_v1_appTableRecord_create',{'文本':'fixture-create'}]]){
  const result=await client.callTool({name,arguments:{path:{...path,...(name.endsWith('update')?{record_id:'record-test'}:{})},data:{fields}}});assert.ok(!result.isError);assert.deepEqual(JSON.parse(result.content[0].text).record.fields,fields);
 }
 assert.ok(!logs.includes('fixture-tenant-token'));assert.ok(!logs.includes('fixture-app-secret'));
 assert.ok(!update.content[0].text.includes('fixture-tenant-token'));
});
