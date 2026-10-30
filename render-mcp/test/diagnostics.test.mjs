import test from 'node:test';
import assert from 'node:assert/strict';
import { feishuError, redact } from '../diagnostics.mjs';

test('403 retains Feishu permission evidence and request identity without credentials', () => {
  const response = new Response('{}', {status:403, headers:{'x-request-id':'req-test','x-tt-logid':'header-log'}});
  const error = feishuError(response, {code:99991672,msg:'Access denied: Bearer private-token',error:{log_id:'feishu-log',permission_violations:[{subject:'base:record:update',type:'action_scope_required'}],app_secret:'private-secret'}}, {method:'PUT',path:'/open-apis/bitable/v1/apps/app/tables/tbl/records/rec?access_token=private-token',appId:'test-app',secrets:['private-token','private-secret']});
  const parsed = JSON.parse(error.message);
  assert.equal(parsed.http_status,403);
  assert.equal(parsed.code,99991672);
  assert.equal(parsed.request.method,'PUT');
  assert.equal(parsed.request.identity,'tenant');
  assert.equal(parsed.log_id,'feishu-log');
  assert.equal(parsed.request_id,'req-test');
  assert.equal(parsed.error.permission_violations[0].subject,'base:record:update');
  assert.ok(!error.message.includes('private-token'));
  assert.ok(!error.message.includes('private-secret'));
  assert.ok(!parsed.request.path.includes('?'));
});

test('HTTP 200 business failure and missing JSON body retain status and safe metadata', () => {
  const error=feishuError(new Response('{}',{status:200}),{code:1254302,msg:'Permission denied'},{method:'PUT',path:'/test',appId:'test-app',useUAT:true});
  assert.equal(error.diagnostic.code,1254302);
  assert.equal(error.diagnostic.request.identity,'user');
  assert.equal(feishuError(new Response('',{status:403}),null,{method:'PUT',path:'/test'}).diagnostic.code,null);
});

test('redacts nested credentials and limits upstream error content', () => {
  const result = redact({nested:{Authorization:'secret',tenant_access_token:'token',refresh_token:'refresh',message:'secret in msg'}},['secret']);
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.equal(result.nested.tenant_access_token,'[REDACTED]');
  assert.equal(redact('x'.repeat(10000)).length,6000);
});
