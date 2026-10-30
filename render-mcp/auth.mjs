import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { InvalidGrantError, InvalidTokenError, InvalidScopeError, InvalidTargetError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

const scope = 'feishu:tools';
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

// A single-owner, confidential OAuth client. Configuration and signing key persist
// in Render environment variables; no Feishu credential is sent to the browser.
export function installAuth(app, env = process.env) {
  const issuer = new URL(env.MCP_PUBLIC_URL || 'https://feishu-mcp-qr4u.onrender.com');
  const resource = new URL('/mcp', issuer).href;
  const clientId = env.MCP_OAUTH_CLIENT_ID || 'feishu-gtd-chatgpt';
  const clientSecret = env.MCP_OAUTH_CLIENT_SECRET || '';
  const password = env.MCP_OWNER_PASSWORD || '';
  const signingKey = env.MCP_OAUTH_SIGNING_KEY || '';
  const configured = [clientSecret, password, signingKey].every(value => value.length >= 32);
  if (!configured) {
    app.use('/mcp', (_req, res) => res.status(503).json({error:'MCP authentication is not configured; access is disabled'}));
    return { configured: false };
  }
  if (issuer.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(issuer.hostname)) throw new Error('MCP_PUBLIC_URL requires HTTPS');
  const redirects = (env.MCP_OAUTH_REDIRECT_URIS || 'https://chatgpt.com/connector_platform_oauth_redirect').split(',').map(s => s.trim());
  const client = { client_id:clientId, client_secret:clientSecret, redirect_uris:redirects, token_endpoint_auth_method:'client_secret_post', grant_types:['authorization_code','refresh_token'], response_types:['code'], scope };
  const pending = new Map();
  const codes = new Map();
  const failedLogins = new Map();
  const now = () => Math.floor(Date.now()/1000);
  const sign = claims => {
    const body = Buffer.from(JSON.stringify({iss:issuer.href,aud:resource,cid:clientId,scope,iat:now(),...claims})).toString('base64url');
    return `${body}.${createHmac('sha256', signingKey).update(body).digest('base64url')}`;
  };
  const verify = (token, type) => {
    try {
      if (typeof token !== 'string' || token.length > 8192) throw new Error();
      const [body, signature, extra] = token.split('.');
      if (extra || !equal(signature, createHmac('sha256',signingKey).update(body).digest('base64url'))) throw new Error();
      const claims = JSON.parse(Buffer.from(body,'base64url').toString());
      if (claims.type !== type || claims.iss !== issuer.href || claims.aud !== resource || claims.cid !== clientId || claims.scope !== scope || !Number.isFinite(claims.exp) || claims.exp <= now()) throw new Error();
      return claims;
    } catch { throw new InvalidTokenError('Invalid or expired MCP token'); }
  };
  const checkResource = requested => { if (requested && requested.href !== resource) throw new InvalidTargetError('Resource must match the MCP endpoint'); };
  const checkScopes = scopes => { if (scopes?.some(value => value !== scope)) throw new InvalidScopeError('Unsupported scope'); };
  const tokens = refresh => ({access_token:sign({type:'access',exp:now()+3600}),token_type:'Bearer',expires_in:3600,scope,refresh_token:refresh || sign({type:'refresh',exp:now()+30*86400})});
  const sweep = setInterval(() => {
    for (const store of [pending,codes,failedLogins]) for (const [key,value] of store) if (value.expires < now()) store.delete(key);
  },60000);
  sweep.unref();
  const provider = {
    clientsStore: { getClient: async id => id === clientId ? client : undefined },
    async authorize(_client, params, res) {
      checkResource(params.resource); checkScopes(params.scopes);
      if (pending.size >= 1000) throw new InvalidGrantError('Too many pending authorizations');
      const flow = randomBytes(32).toString('base64url');
      pending.set(flow,{...params,expires:now()+300});
      res.set({'Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",'X-Frame-Options':'DENY','Referrer-Policy':'no-referrer'});
      res.type('html').send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>飞书 GTD 授权</title><h1>连接飞书 GTD</h1><p>仅服务所有者可授权。允许 ChatGPT 使用此服务读取和修改飞书数据。</p><p>回调地址：${escape(params.redirectUri)}</p><form method="post" action="/oauth/consent"><input type="hidden" name="flow" value="${flow}"><label>MCP 登录密码 <input type="password" name="password" required autocomplete="current-password" maxlength="512"></label><button type="submit">授权连接</button></form></html>`);
    },
    async challengeForAuthorizationCode(_client, code) {
      const grant=codes.get(code);
      if (!grant || grant.expires <= now()) throw new InvalidGrantError('Invalid authorization code');
      return grant.codeChallenge;
    },
    async exchangeAuthorizationCode(_client, code, _verifier, redirectUri, requested) {
      const grant=codes.get(code);
      codes.delete(code);
      if (!grant || grant.expires <= now() || redirectUri !== grant.redirectUri) throw new InvalidGrantError('Invalid authorization code or redirect URI');
      checkResource(requested);
      return tokens();
    },
    async exchangeRefreshToken(_client, token, scopes, requested) {
      checkResource(requested); checkScopes(scopes); verify(token,'refresh');
      // Confidential client authentication protects refresh; absolute expiry does
      // not slide. Rotating the signing key revokes all grants across restarts.
      return tokens(token);
    },
    async verifyAccessToken(token) {
      const claims=verify(token,'access');
      return {token,clientId,scopes:[scope],expiresAt:claims.exp,resource:new URL(resource)};
    },
  };
  app.post('/oauth/consent',express.urlencoded({extended:false,limit:'4kb'}),(req,res) => {
    res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"});
    if (req.get('origin') !== issuer.origin) return res.status(403).send('Invalid origin');
    const ip=req.ip;
    const attempts=failedLogins.get(ip);
    if (attempts?.expires > now() && attempts.count >= 10) return res.status(429).send('Too many attempts; try again in 15 minutes');
    const flow=typeof req.body.flow === 'string' ? req.body.flow : '';
    const grant=pending.get(flow);
    if (!grant || grant.expires <= now()) return res.status(400).send('Authorization expired; reconnect in ChatGPT');
    if (!equal(req.body.password,password)) {
      if (failedLogins.size >= 10000) return res.status(429).send('Try again later');
      failedLogins.set(ip,{count:attempts?.expires > now() ? attempts.count+1 : 1,expires:attempts?.expires > now() ? attempts.expires : now()+900});
      return res.status(403).send('Invalid MCP password');
    }
    pending.delete(flow);
    if (codes.size >= 1000) return res.status(429).send('Try again later');
    const code=randomBytes(32).toString('base64url');
    codes.set(code,{...grant,expires:now()+60});
    const callback=new URL(grant.redirectUri);
    callback.searchParams.set('code',code);
    if (grant.state) callback.searchParams.set('state',grant.state);
    callback.searchParams.set('iss',issuer.href);
    res.redirect(303,callback.href);
  });
  // Publish issuer identification so ChatGPT can use its stable callback URL.
  app.get('/.well-known/oauth-authorization-server',(_req,res) => res.json({issuer:issuer.href,authorization_endpoint:new URL('/authorize',issuer).href,token_endpoint:new URL('/token',issuer).href,response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],token_endpoint_auth_methods_supported:['client_secret_post'],code_challenge_methods_supported:['S256'],scopes_supported:[scope],authorization_response_iss_parameter_supported:true}));
  app.use(mcpAuthRouter({provider,issuerUrl:issuer,resourceServerUrl:new URL(resource),scopesSupported:[scope],resourceName:'Feishu GTD'}));
  app.use('/mcp',requireBearerAuth({verifier:provider,requiredScopes:[scope],resourceMetadataUrl:new URL('/.well-known/oauth-protected-resource/mcp',issuer).href}));
  return {configured:true,provider};
}
