// Operator-only cleanup for the user-designated empty test table. This is never
// registered as an MCP tool. The control-plane inputs expire and bind deletion
// to a newly created record's exact marker; original records are always denied.
const appToken = 'UNbObz9ADaxRGusGkFccSXMGnRf';
const tableId = 'tblkFygRcDR4AuvT';
const originals = new Set(['reczz28TaGBr322X','reczz28TaGBr34g4','reczz28TaGBr356Z','reczz28TaGBr35Sr','reczz28TaGBr36OE']);
export async function cleanupVerificationRecord(api, env = process.env, now = Date.now()) {
  const id = env.MCP_VERIFY_CLEANUP_RECORD_ID;
  if (!id) return {status:'disabled'};
  const deadline = Date.parse(env.MCP_VERIFY_CLEANUP_UNTIL || '');
  if (!Number.isFinite(deadline) || deadline <= now) return {status:'expired'};
  const marker = env.MCP_VERIFY_CLEANUP_MARKER || '';
  if (env.APP_ID !== 'cli_aae195540df8dd24' || !/^rec[A-Za-z0-9]+$/.test(id) || originals.has(id) || deadline > now + 3600000 || !/^MCP_CREATE_VERIFY_[0-9a-f-]{36}$/.test(marker)) throw new Error('Verification cleanup configuration rejected');
  const path = `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${id}`;
  let data;
  try { data = await api('GET',path); }
  catch (error) { if (error.code === 1254043) return {status:'already_absent',record_id:id}; throw error; }
  const record = data.record;
  const value = record?.fields?.['文本'];
  const text = Array.isArray(value) ? value.map(item => item.text || '').join('') : value;
  if ((record?.record_id || record?.id) !== id || Object.keys(record.fields).length !== 1 || text !== marker) throw new Error('Verification cleanup marker mismatch; record preserved');
  const result = await api('DELETE',path);
  if (result.deleted !== true || result.record_id !== id) throw new Error('Verification cleanup did not confirm deletion');
  return {status:'deleted',record_id:id};
}
