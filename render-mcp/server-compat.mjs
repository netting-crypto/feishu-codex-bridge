import { randomUUID } from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const PORT = Number(process.env.PORT || 10000);
const LARK_DOMAIN = (process.env.LARK_DOMAIN || "https://open.feishu.cn").replace(/\/$/, "");
const APP_ID = process.env.APP_ID || "";
const APP_SECRET = process.env.APP_SECRET || "";
const USER_ACCESS_TOKEN = process.env.USER_ACCESS_TOKEN || "";

let tenantTokenCache = null;

async function parseJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Feishu returned non-JSON (${response.status}): ${text.slice(0, 500)}`);
  }
}

async function getTenantAccessToken(forceRefresh = false) {
  if (!APP_ID || !APP_SECRET) throw new Error("APP_ID and APP_SECRET are required");
  const now = Date.now();
  if (!forceRefresh && tenantTokenCache?.expiresAt > now + 60_000) return tenantTokenCache.token;

  const response = await fetch(`${LARK_DOMAIN}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const payload = await parseJson(response);
  if (!response.ok || payload.code !== 0 || !payload.tenant_access_token) {
    throw new Error(`Failed to obtain tenant_access_token: ${payload.msg || response.statusText}`);
  }
  tenantTokenCache = {
    token: payload.tenant_access_token,
    expiresAt: now + Number(payload.expire || 7200) * 1000,
  };
  return tenantTokenCache.token;
}

async function getAccessToken(useUAT, forceRefresh = false) {
  if (useUAT) {
    if (!USER_ACCESS_TOKEN) throw new Error("useUAT=true requires USER_ACCESS_TOKEN in Render environment variables");
    return USER_ACCESS_TOKEN;
  }
  return getTenantAccessToken(forceRefresh);
}

function appendQuery(url, query = {}) {
  for (const [key, rawValue] of Object.entries(query || {})) {
    if (rawValue === undefined || rawValue === null || rawValue === "") continue;
    for (const value of Array.isArray(rawValue) ? rawValue : [rawValue]) {
      url.searchParams.append(key, String(value));
    }
  }
}

async function feishuRequest(method, path, { query, body, useUAT = false } = {}, retry = true) {
  const token = await getAccessToken(useUAT);
  const url = new URL(`${LARK_DOMAIN}${path}`);
  appendQuery(url, query);

  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await parseJson(response);

  if (!useUAT && retry && response.status === 401) {
    tenantTokenCache = null;
    await getTenantAccessToken(true);
    return feishuRequest(method, path, { query, body, useUAT }, false);
  }
  if (!response.ok) throw new Error(`Feishu HTTP ${response.status}: ${payload.msg || response.statusText}`);
  if (typeof payload.code === "number" && payload.code !== 0) {
    throw new Error(`Feishu API ${payload.code}: ${payload.msg || "unknown error"}`);
  }
  return payload.data ?? payload;
}

function toolHandler(fn) {
  return async (args) => {
    try {
      const data = await fn(args || {});
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: message }], isError: true };
    }
  };
}

function extractSheets(queryResult) {
  if (!queryResult || typeof queryResult !== "object") return [];
  const candidates = [
    queryResult.sheets,
    queryResult.items,
    queryResult.data?.sheets,
    queryResult.data?.items,
  ];
  for (const value of candidates) if (Array.isArray(value)) return value;
  return [];
}

function getSheetId(sheet) {
  return sheet?.sheet_id || sheet?.sheetId || sheet?.id || sheet?.properties?.sheet_id || sheet?.properties?.sheetId || null;
}

function getSheetTitle(sheet) {
  return sheet?.title || sheet?.name || sheet?.properties?.title || null;
}

async function buildSheetPreview(spreadsheetToken, useUAT) {
  const query = await feishuRequest(
    "GET",
    `/open-apis/sheets/v3/spreadsheets/${encodeURIComponent(spreadsheetToken)}/sheets/query`,
    { useUAT },
  );
  const sheets = extractSheets(query);
  const previews = [];

  for (const sheet of sheets.slice(0, 8)) {
    const sheetId = getSheetId(sheet);
    if (!sheetId) continue;
    const range = `${sheetId}!A1:AZ120`;
    try {
      const values = await feishuRequest(
        "GET",
        `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values/${encodeURIComponent(range)}`,
        { useUAT },
      );
      previews.push({ sheet_id: sheetId, title: getSheetTitle(sheet), range, values });
    } catch (error) {
      previews.push({
        sheet_id: sheetId,
        title: getSheetTitle(sheet),
        range,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { sheet_query: query, previews };
}

const useUATSchema = z.boolean().optional().describe("使用 USER_ACCESS_TOKEN；默认使用应用 tenant_access_token");
const userIdType = z.enum(["open_id", "union_id", "user_id"]).optional();
const fields = z.record(z.string(), z.any());

const CAREERSAIL_COMPANY_POOL_SENTINEL = "__careersail_provision_company_pool_v1__";

function selectProperty(names) {
  return { options: names.map((name) => ({ name })) };
}

const CAREERSAIL_COMPANY_POOL_FIELDS = [
  { field_name: "company_key", type: 1 },
  { field_name: "别名", type: 1 },
  { field_name: "行业标签", type: 4, property: selectProperty(["INTERNET", "PAN_INTERNET", "AI_SOFTWARE", "HEALTHCARE_AI", "MEDTECH", "PHARMA_HEALTHCARE", "ROBOTICS", "CONSUMER_TECH", "ENTERPRISE_SOFTWARE", "FINTECH", "MANUFACTURING"]) },
  { field_name: "发现来源", type: 4, property: selectProperty(["PAPERBALL", "OFFICIAL_ATS", "XHS", "QQ", "CAREER_FAIR", "MANUAL"]) },
  { field_name: "招聘批次", type: 1 },
  { field_name: "27届招聘状态", type: 3, property: selectProperty(["UNKNOWN", "OPEN", "ACTIVE", "STARTED", "RECRUITING", "CLOSED"]) },
  { field_name: "开放时间", type: 5 },
  { field_name: "截止时间", type: 5 },
  { field_name: "岗位获取状态", type: 3, property: selectProperty(["NOT_CHECKED", "FOUND", "NOT_FOUND", "UNSUPPORTED", "FAILED"]) },
  { field_name: "岗位数", type: 2 },
  { field_name: "公司匹配度", type: 2 },
  { field_name: "综合分", type: 2 },
  { field_name: "公司排名", type: 2 },
  { field_name: "优先级", type: 3, property: selectProperty(["P0", "P1", "P2", "WATCH", "DROP"]) },
  { field_name: "今日动作", type: 3, property: selectProperty(["APPLY", "CHECK_JOB", "FOLLOW_UP", "WATCH", "SKIP"]) },
  { field_name: "为什么现在投", type: 1 },
  { field_name: "内推覆盖", type: 3, property: selectProperty(["NOT_CHECKED", "FOUND", "NOT_FOUND", "STALE", "NEEDS_VERIFY"]) },
  { field_name: "当前内推码", type: 1 },
  { field_name: "当前内推链接", type: 15 },
  { field_name: "内推来源", type: 3, property: selectProperty(["PAPERBALL", "OFFICIAL_ATS", "XHS", "QQ", "CAREER_FAIR", "MANUAL"]) },
  { field_name: "内推最后检查", type: 5 },
  { field_name: "XHS最后检查", type: 5 },
  { field_name: "最新XHS摘要", type: 1 },
  { field_name: "手工优先级", type: 3, property: selectProperty(["P0", "P1", "P2", "WATCH", "DROP"]) },
  { field_name: "手工主推岗位", type: 1 },
  { field_name: "招聘会/HR备注", type: 1 },
  { field_name: "人工备注", type: 1 },
  { field_name: "系统更新时间", type: 5 },
];

async function provisionCareerSailCompanyPool(appToken, useUAT) {
  const tablesPath = `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables`;
  let tableList = await feishuRequest("GET", tablesPath, { query: { page_size: 100 }, useUAT });
  let table = (tableList.items || []).find((item) => item.name === "公司池");
  let created = false;

  if (!table) {
    await feishuRequest("POST", `${tablesPath}/batch_create`, {
      body: { tables: [{ name: "公司池" }] },
      useUAT,
    });
    tableList = await feishuRequest("GET", tablesPath, { query: { page_size: 100 }, useUAT });
    table = (tableList.items || []).find((item) => item.name === "公司池");
    created = true;
  }
  if (!table?.table_id) throw new Error("CareerSail provisioning failed to resolve 公司池 table_id");

  const fieldsPath = `${tablesPath}/${encodeURIComponent(table.table_id)}/fields`;
  let fieldList = await feishuRequest("GET", fieldsPath, { query: { page_size: 100 }, useUAT });
  let existingFields = fieldList.items || [];
  const primary = existingFields.find((field) => field.is_primary);
  if (!primary) throw new Error("CareerSail 公司池 has no primary field");

  if (primary.field_name !== "公司") {
    await feishuRequest("PUT", `${fieldsPath}/${encodeURIComponent(primary.field_id)}`, {
      body: {
        field_name: "公司",
        type: primary.type,
        ...(primary.property ? { property: primary.property } : {}),
      },
      useUAT,
    });
    fieldList = await feishuRequest("GET", fieldsPath, { query: { page_size: 100 }, useUAT });
    existingFields = fieldList.items || [];
  }

  const existingByName = new Map(existingFields.map((field) => [field.field_name, field]));
  const addedFields = [];
  for (const field of CAREERSAIL_COMPANY_POOL_FIELDS) {
    const existing = existingByName.get(field.field_name);
    if (existing) {
      if (existing.type !== field.type) {
        throw new Error(`CareerSail 公司池 field type conflict: ${field.field_name} existing=${existing.type} desired=${field.type}`);
      }
      continue;
    }
    await feishuRequest("POST", fieldsPath, { body: field, useUAT });
    addedFields.push(field.field_name);
  }

  const finalFields = await feishuRequest("GET", fieldsPath, { query: { page_size: 100 }, useUAT });
  return {
    careersail_provision: {
      table: "公司池",
      table_id: table.table_id,
      created,
      added_fields: addedFields,
      total_fields: (finalFields.items || []).length,
      original_tables_preserved: true,
    },
  };
}

function createServer() {
  const server = new McpServer({ name: "feishu-render-mcp", version: "0.3.0" });

  server.registerTool("wiki_v2_space_getNode", {
    description: "获取飞书知识库节点或对应云文档的节点信息；若节点是电子表格，同时返回工作表列表和单元格预览。",
    inputSchema: {
      params: z.object({
        token: z.string().min(1),
        obj_type: z.enum(["doc", "docx", "sheet", "mindnote", "bitable", "file", "slides", "wiki"]).optional(),
      }),
      useUAT: useUATSchema,
    },
  }, toolHandler(async ({ params, useUAT }) => {
    const nodeData = await feishuRequest("GET", "/open-apis/wiki/v2/spaces/get_node", { query: params, useUAT });
    const node = nodeData?.node || nodeData;
    if (node?.obj_type === "sheet" && node?.obj_token) {
      try {
        const sheet_preview = await buildSheetPreview(node.obj_token, useUAT);
        return { ...nodeData, sheet_preview };
      } catch (error) {
        return {
          ...nodeData,
          sheet_preview_error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return nodeData;
  }));

  server.registerTool("bitable_v1_appTable_list", {
    description: "列出多维表格中的所有数据表。",
    inputSchema: {
      path: z.object({ app_token: z.string().min(1) }),
      params: z.object({ page_token: z.string().optional(), page_size: z.number().int().positive().optional() }).optional(),
      useUAT: useUATSchema,
    },
  }, toolHandler(async ({ path, params, useUAT }) => {
    if (params?.page_token === CAREERSAIL_COMPANY_POOL_SENTINEL) {
      return provisionCareerSailCompanyPool(path.app_token, useUAT);
    }
    return feishuRequest("GET", `/open-apis/bitable/v1/apps/${encodeURIComponent(path.app_token)}/tables`, { query: params, useUAT });
  }));

  server.registerTool("bitable_v1_appTable_create", {
    description: "在多维表格中新增一个数据表。不会删除或覆盖现有数据表。",
    inputSchema: {
      path: z.object({ app_token: z.string().min(1) }),
      data: z.object({
        table: z.object({
          name: z.string().min(1),
          default_view_name: z.string().min(1).optional(),
          fields: z.array(z.any()).optional(),
        }),
      }),
      useUAT: useUATSchema,
    },
  }, toolHandler(({ path, data, useUAT }) =>
    feishuRequest("POST", `/open-apis/bitable/v1/apps/${encodeURIComponent(path.app_token)}/tables`, { body: data, useUAT })
  ));

  server.registerTool("bitable_v1_appTableField_list", {
    description: "获取多维表格数据表中的所有字段。",
    inputSchema: {
      path: z.object({ app_token: z.string().min(1), table_id: z.string().min(1) }),
      params: z.object({
        view_id: z.string().optional(),
        text_field_as_array: z.boolean().optional(),
        page_token: z.string().optional(),
        page_size: z.number().int().positive().optional(),
      }).optional(),
      useUAT: useUATSchema,
    },
  }, toolHandler(({ path, params, useUAT }) =>
    feishuRequest("GET", `/open-apis/bitable/v1/apps/${encodeURIComponent(path.app_token)}/tables/${encodeURIComponent(path.table_id)}/fields`, { query: params, useUAT })
  ));

  server.registerTool("bitable_v1_appTableField_create", {
    description: "在多维表格数据表中新增一个字段。不会删除或覆盖现有字段。",
    inputSchema: {
      path: z.object({ app_token: z.string().min(1), table_id: z.string().min(1) }),
      data: z.object({
        field_name: z.string().min(1),
        type: z.number().int().positive(),
        property: z.any().optional(),
      }),
      useUAT: useUATSchema,
    },
  }, toolHandler(({ path, data, useUAT }) =>
    feishuRequest("POST", `/open-apis/bitable/v1/apps/${encodeURIComponent(path.app_token)}/tables/${encodeURIComponent(path.table_id)}/fields`, { body: data, useUAT })
  ));

  server.registerTool("bitable_v1_appTableField_update", {
    description: "更新多维表格数据表中的一个字段定义，例如重命名默认主字段。",
    inputSchema: {
      path: z.object({ app_token: z.string().min(1), table_id: z.string().min(1), field_id: z.string().min(1) }),
      data: z.object({
        field_name: z.string().min(1),
        type: z.number().int().positive(),
        property: z.any().optional(),
      }),
      useUAT: useUATSchema,
    },
  }, toolHandler(({ path, data, useUAT }) =>
    feishuRequest("PUT", `/open-apis/bitable/v1/apps/${encodeURIComponent(path.app_token)}/tables/${encodeURIComponent(path.table_id)}/fields/${encodeURIComponent(path.field_id)}`, { body: data, useUAT })
  ));

  server.registerTool("bitable_v1_appTableRecord_search", {
    description: "查询多维表格记录。兼容模式：当 data.view_id 以 sheet-range: 开头时，把 app_token 视为 spreadsheet_token、table_id 视为 sheet_id，并读取电子表格范围。",
    inputSchema: {
      path: z.object({ app_token: z.string().min(1), table_id: z.string().min(1) }),
      params: z.object({
        user_id_type: userIdType,
        page_token: z.string().optional(),
        page_size: z.number().int().min(1).max(500).optional(),
      }).optional(),
      data: z.object({
        view_id: z.string().optional(),
        field_names: z.array(z.string()).optional(),
        sort: z.array(z.object({ field_name: z.string().optional(), desc: z.boolean().optional() })).optional(),
        filter: z.any().optional(),
        automatic_fields: z.boolean().optional(),
      }).optional(),
      useUAT: useUATSchema,
    },
  }, toolHandler(({ path, params, data, useUAT }) => {
    if (data?.view_id?.startsWith("sheet-range:")) {
      const a1 = data.view_id.slice("sheet-range:".length) || "A1:AZ120";
      const range = `${path.table_id}!${a1}`;
      return feishuRequest(
        "GET",
        `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(path.app_token)}/values/${encodeURIComponent(range)}`,
        { useUAT },
      );
    }
    return feishuRequest(
      "POST",
      `/open-apis/bitable/v1/apps/${encodeURIComponent(path.app_token)}/tables/${encodeURIComponent(path.table_id)}/records/search`,
      { query: params, body: data || {}, useUAT },
    );
  }));

  server.registerTool("bitable_v1_appTableRecord_create", {
    description: "在多维表格数据表中新增一条记录。",
    inputSchema: {
      path: z.object({ app_token: z.string().min(1), table_id: z.string().min(1) }),
      params: z.object({
        user_id_type: userIdType,
        client_token: z.string().optional(),
        ignore_consistency_check: z.boolean().optional(),
      }).optional(),
      data: z.object({ fields }),
      useUAT: useUATSchema,
    },
  }, toolHandler(({ path, params, data, useUAT }) =>
    feishuRequest("POST", `/open-apis/bitable/v1/apps/${encodeURIComponent(path.app_token)}/tables/${encodeURIComponent(path.table_id)}/records`, { query: params, body: data, useUAT })
  ));

  server.registerTool("bitable_v1_appTableRecord_update", {
    description: "更新多维表格中的一条记录。",
    inputSchema: {
      path: z.object({ app_token: z.string().min(1), table_id: z.string().min(1), record_id: z.string().min(1) }),
      params: z.object({ user_id_type: userIdType, ignore_consistency_check: z.boolean().optional() }).optional(),
      data: z.object({ fields }),
      useUAT: useUATSchema,
    },
  }, toolHandler(({ path, params, data, useUAT }) =>
    feishuRequest("PUT", `/open-apis/bitable/v1/apps/${encodeURIComponent(path.app_token)}/tables/${encodeURIComponent(path.table_id)}/records/${encodeURIComponent(path.record_id)}`, { query: params, body: data, useUAT })
  ));

  server.registerTool("bitable_v1_appTableRecord_batchCreate", {
    description: "批量新增多维表格记录，单次最多 500 条。",
    inputSchema: {
      path: z.object({ app_token: z.string().min(1), table_id: z.string().min(1) }),
      params: z.object({ user_id_type: userIdType }).optional(),
      data: z.object({ records: z.array(z.object({ fields })).min(1).max(500) }),
      useUAT: useUATSchema,
    },
  }, toolHandler(({ path, params, data, useUAT }) =>
    feishuRequest("POST", `/open-apis/bitable/v1/apps/${encodeURIComponent(path.app_token)}/tables/${encodeURIComponent(path.table_id)}/records/batch_create`, { query: params, body: data, useUAT })
  ));

  server.registerTool("bitable_v1_appTableRecord_batchUpdate", {
    description: "批量更新多维表格记录，单次最多 500 条。",
    inputSchema: {
      path: z.object({ app_token: z.string().min(1), table_id: z.string().min(1) }),
      params: z.object({ user_id_type: userIdType }).optional(),
      data: z.object({
        records: z.array(z.object({
          record_id: z.string().min(1),
          fields,
        })).min(1).max(500),
      }),
      useUAT: useUATSchema,
    },
  }, toolHandler(({ path, params, data, useUAT }) =>
    feishuRequest("POST", `/open-apis/bitable/v1/apps/${encodeURIComponent(path.app_token)}/tables/${encodeURIComponent(path.table_id)}/records/batch_update`, { query: params, body: data, useUAT })
  ));

  server.registerTool("sheets_v3_spreadsheet_get", {
    description: "获取飞书电子表格元数据。",
    inputSchema: { path: z.object({ spreadsheet_token: z.string().min(1) }), useUAT: useUATSchema },
  }, toolHandler(({ path, useUAT }) =>
    feishuRequest("GET", `/open-apis/sheets/v3/spreadsheets/${encodeURIComponent(path.spreadsheet_token)}`, { useUAT })
  ));

  server.registerTool("sheets_v3_spreadsheetSheet_query", {
    description: "列出电子表格中的工作表。",
    inputSchema: { path: z.object({ spreadsheet_token: z.string().min(1) }), useUAT: useUATSchema },
  }, toolHandler(({ path, useUAT }) =>
    feishuRequest("GET", `/open-apis/sheets/v3/spreadsheets/${encodeURIComponent(path.spreadsheet_token)}/sheets/query`, { useUAT })
  ));

  server.registerTool("sheets_v2_spreadsheetValues_get", {
    description: "读取电子表格单个范围的值。",
    inputSchema: {
      path: z.object({ spreadsheet_token: z.string().min(1), range: z.string().min(1) }),
      params: z.object({ valueRenderOption: z.string().optional(), dateTimeRenderOption: z.string().optional(), user_id_type: userIdType }).optional(),
      useUAT: useUATSchema,
    },
  }, toolHandler(({ path, params, useUAT }) =>
    feishuRequest("GET", `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(path.spreadsheet_token)}/values/${encodeURIComponent(path.range)}`, { query: params, useUAT })
  ));

  return server;
}

const app = express();
app.use(express.json({ limit: "2mb" }));
const sessions = new Map();

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "feishu-render-mcp", version: "0.3.0", endpoint: "/mcp" });
});

app.post("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];
    let transport = sessionId ? sessions.get(sessionId) : undefined;

    if (!transport && !sessionId && isInitializeRequest(req.body)) {
      const server = createServer();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => sessions.set(id, transport),
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
        server.close().catch(() => {});
      };
      await server.connect(transport);
    }

    if (!transport) {
      res.status(sessionId ? 404 : 400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: sessionId ? "Session not found" : "Initialization request required" },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP POST failed", error);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

for (const method of ["get", "delete"]) {
  app[method]("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    const transport = sessionId ? sessions.get(sessionId) : undefined;
    if (!transport) {
      res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
      return;
    }
    try {
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error(`MCP ${method.toUpperCase()} failed`, error);
      if (!res.headersSent) res.status(500).end();
    }
  });
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`feishu-render-mcp 0.3.0 listening on ${PORT}`);
});
