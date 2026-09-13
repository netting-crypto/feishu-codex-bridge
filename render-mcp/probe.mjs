const LARK_DOMAIN = (process.env.LARK_DOMAIN || "https://open.feishu.cn").replace(/\/$/, "");
const APP_ID = process.env.APP_ID || "";
const APP_SECRET = process.env.APP_SECRET || "";
const SHEET_PROBE_TOKEN = process.env.SHEET_PROBE_TOKEN || "";
const SHEET_PROBE_ID = process.env.SHEET_PROBE_ID || "";

async function json(response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : {}; }
  catch { throw new Error(`non-JSON ${response.status}`); }
}

async function run() {
  if (!SHEET_PROBE_TOKEN || !SHEET_PROBE_ID) return;
  if (!APP_ID || !APP_SECRET) throw new Error("APP_ID/APP_SECRET missing");

  const authRes = await fetch(`${LARK_DOMAIN}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const auth = await json(authRes);
  if (!authRes.ok || auth.code !== 0 || !auth.tenant_access_token) {
    throw new Error(`auth failed: ${auth.msg || authRes.status}`);
  }

  const range = `${SHEET_PROBE_ID}!A1:AZ120`;
  const url = `${LARK_DOMAIN}/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(SHEET_PROBE_TOKEN)}/values/${encodeURIComponent(range)}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${auth.tenant_access_token}` } });
  const payload = await json(res);
  if (!res.ok || (typeof payload.code === "number" && payload.code !== 0)) {
    throw new Error(`sheet read failed: ${payload.msg || res.status}`);
  }

  const data = payload.data || payload;
  const vr = data.valueRange || data.value_range || data;
  const values = Array.isArray(vr.values) ? vr.values : [];
  const rows = values.length;
  const cols = values.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0);
  const nonempty = values.reduce((n, r) => n + (Array.isArray(r) ? r.filter(v => v !== null && v !== undefined && String(v) !== "").length : 0), 0);
  console.log(`SHEET_PROBE_OK sheet=${SHEET_PROBE_ID} rows=${rows} cols=${cols} nonempty=${nonempty}`);
  const sample = values.slice(0, 20).map(r => Array.isArray(r) ? r.slice(0, 20) : r);
  console.log(`SHEET_PROBE_SAMPLE ${JSON.stringify(sample)}`);
}

run().catch(error => {
  console.error(`SHEET_PROBE_FAIL ${error instanceof Error ? error.message : String(error)}`);
});
