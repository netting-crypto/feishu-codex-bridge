import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanupVerificationRecord} from '../verification-cleanup.mjs';
const now=Date.now();
const env={APP_ID:'cli_aae195540df8dd24',MCP_VERIFY_CLEANUP_RECORD_ID:'recNewVerification',MCP_VERIFY_CLEANUP_UNTIL:new Date(now+1800000).toISOString(),MCP_VERIFY_CLEANUP_MARKER:'MCP_CREATE_VERIFY_12345678-1234-1234-1234-123456789abc'};
test('cleanup is disabled or expired without touching Feishu',async()=>{
 const api=()=>{throw new Error('must not call upstream');};
 assert.equal((await cleanupVerificationRecord(api,{},now)).status,'disabled');
 assert.equal((await cleanupVerificationRecord(api,{...env,MCP_VERIFY_CLEANUP_UNTIL:new Date(now-1).toISOString()},now)).status,'expired');
 await assert.rejects(cleanupVerificationRecord(api,{...env,MCP_VERIFY_CLEANUP_RECORD_ID:'reczz28TaGBr322X'},now),/configuration rejected/);
 await assert.rejects(cleanupVerificationRecord(api,{...env,APP_ID:'another-app'},now),/configuration rejected/);
});
test('cleanup refuses changed markers or records with additional data',async()=>{
 for(const fields of [{'文本':'changed'},{'文本':env.MCP_VERIFY_CLEANUP_MARKER,another:'preserve'}]){
  const calls=[];await assert.rejects(cleanupVerificationRecord(async(method,path)=>{calls.push(method);return {record:{record_id:env.MCP_VERIFY_CLEANUP_RECORD_ID,fields}};},env,now),/marker mismatch/);assert.deepEqual(calls,['GET']);
 }
});
test('cleanup deletes only the exact new test record and tolerates already removed data',async()=>{
 const calls=[];
 const result=await cleanupVerificationRecord(async(method,path)=>{calls.push({method,path});return method==='GET'?{record:{record_id:env.MCP_VERIFY_CLEANUP_RECORD_ID,fields:{'文本':env.MCP_VERIFY_CLEANUP_MARKER}}}:{deleted:true,record_id:env.MCP_VERIFY_CLEANUP_RECORD_ID};},env,now);
 assert.equal(result.status,'deleted');assert.deepEqual(calls.map(c=>c.method),['GET','DELETE']);assert.ok(calls.every(c=>c.path.endsWith('/'+env.MCP_VERIFY_CLEANUP_RECORD_ID)));
 assert.equal((await cleanupVerificationRecord(async()=>{throw Object.assign(new Error('absent'),{code:1254043});},env,now)).status,'already_absent');
});
