const LARK_DOMAIN = (process.env.LARK_DOMAIN || "https://open.feishu.cn").replace(/\/$/, "");
const APP_ID = process.env.APP_ID || "";
const APP_SECRET = process.env.APP_SECRET || "";
const SHEET_PROBE_TOKEN = process.env.SHEET_PROBE_TOKEN || "";
const SHEET_PROBE_ID = process.env.SHEET_PROBE_ID || "";
const BITABLE_PROBE_WIKI_TOKEN = process.env.BITABLE_PROBE_WIKI_TOKEN || "";
const BITABLE_PROBE_TABLE_ID = process.env.BITABLE_PROBE_TABLE_ID || "";
const BITABLE_PROBE_VIEW_ID = process.env.BITABLE_PROBE_VIEW_ID || "";

async function json(response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : {}; }
  catch { throw new Error(`non-JSON ${response.status}`); }
}

async function getTenantToken() {
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
  return auth.tenant_access_token;
}

async function api(token, method, path, body) {
  const res = await fetch(`${LARK_DOMAIN}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await json(res);
  if (!res.ok || (typeof payload.code === "number" && payload.code !== 0)) {
    throw new Error(`${method} ${path} failed: ${payload.msg || res.status}`);
  }
  return payload.data || payload;
}

async function runSheetProbe(token) {
  if (!SHEET_PROBE_TOKEN || !SHEET_PROBE_ID) return;
  const range = `${SHEET_PROBE_ID}!A1:AZ120`;
  const path = `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(SHEET_PROBE_TOKEN)}/values/${encodeURIComponent(range)}`;
  const data = await api(token, "GET", path);
  const vr = data.valueRange || data.value_range || data;
  const values = Array.isArray(vr.values) ? vr.values : [];
  const rows = values.length;
  const cols = values.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0);
  const nonempty = values.reduce((n, r) => n + (Array.isArray(r) ? r.filter(v => v !== null && v !== undefined && String(v) !== "").length : 0), 0);
  console.log(`SHEET_PROBE_OK sheet=${SHEET_PROBE_ID} rows=${rows} cols=${cols} nonempty=${nonempty}`);
}

async function runBitableProbe(token) {
  if (!BITABLE_PROBE_WIKI_TOKEN || !BITABLE_PROBE_TABLE_ID) return;
  const nodeData = await api(
    token,
    "GET",
    `/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(BITABLE_PROBE_WIKI_TOKEN)}&obj_type=wiki`,
  );
  const node = nodeData.node || nodeData;
  const appToken = node.obj_token;
  if (!appToken || node.obj_type !== "bitable") {
    throw new Error(`wiki target is not bitable: obj_type=${node.obj_type || "unknown"}`);
  }

  const viewQuery = BITABLE_PROBE_VIEW_ID ? `?view_id=${encodeURIComponent(BITABLE_PROBE_VIEW_ID)}&page_size=100` : "?page_size=100";
  const fieldsData = await api(
    token,
    "GET",
    `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(BITABLE_PROBE_TABLE_ID)}/fields${viewQuery}`,
  );
  const fields = Array.isArray(fieldsData.items) ? fieldsData.items : [];

  const recordsData = await api(
    token,
    "POST",
    `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(BITABLE_PROBE_TABLE_ID)}/records/search?page_size=5`,
    BITABLE_PROBE_VIEW_ID ? { view_id: BITABLE_PROBE_VIEW_ID } : {},
  );
  const items = Array.isArray(recordsData.items) ? recordsData.items : [];
  console.log(`BITABLE_PROBE_OK title=${JSON.stringify(node.title || "")} table=${BITABLE_PROBE_TABLE_ID} view=${BITABLE_PROBE_VIEW_ID || "default"} fields=${fields.length} sample_records=${items.length} total=${recordsData.total ?? "unknown"}`);
}

async function run() {
  const token = await getTenantToken();
  await runSheetProbe(token);
  await runBitableProbe(token);
}

run().catch(error => {
  console.error(`PROBE_FAIL ${error instanceof Error ? error.message : String(error)}`);
});
