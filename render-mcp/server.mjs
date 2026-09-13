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
  if (!forceRefresh && tenantTokenCache?.expiresAt > now + 60_000) {
    return tenantTokenCache.token;
  }

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
    if (!USER_ACCESS_TOKEN) {
      throw new Error("useUAT=true requires USER_ACCESS_TOKEN in Render environment variables");
    }
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

  if (!response.ok) {
    throw new Error(`Feishu HTTP ${response.status}: ${payload.msg || response.statusText}`);
  }
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

const useUAT = z.boolean().optional().describe("使用 USER_ACCESS_TOKEN；默认使用应用 tenant_access_token");
const userIdType = z.enum(["open_id", "union_id", "user_id"]).optional();
const fields = z.record(z.string(), z.any());

function createServer() {
  const server = new McpServer({ name: "feishu-render-mcp", version: "0.2.0" });

  server.registerTool("wiki_v2_space_getNode", {
    description: "获取飞书知识库节点或对应云文档的节点信息。",
    inputSchema: {
      params: z.object({
        token: z.string().min(1),
        obj_type: z.enum(["doc", "docx", "sheet", "mindnote", "bitable", "file", "slides", "wiki"]).optional(),
      }),
      useUAT,
    },
  }, toolHandler(({ params, useUAT }) =>
    feishuRequest("GET", "/open-apis/wiki/v2/spaces/get_node", { query: params, useUAT })
  ));

  server.registerTool("bitable_v1_appTable_list", {
    description: "列出多维表格中的所有数据表。",
    inputSchema: {
      path: z.object({ app_token: z.string().min(1) }),
      params: z.object({ page_token: z.string().optional(), page_size: z.number().int().positive().optional() }).optional(),
      useUAT,
    },
  }, toolHandler(({ path, params, useUAT }) =>
    feishuRequest("GET", `/open-apis/bitable/v1/apps/${encodeURIComponent(path.app_token)}/tables`, { query: params, useUAT })
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
      useUAT,
    },
  }, toolHandler(({ path, params, useUAT }) =>
    feishuRequest("GET", `/open-apis/bitable/v1/apps/${encodeURIComponent(path.app_token)}/tables/${encodeURIComponent(path.table_id)}/fields`, { query: params, useUAT })
  ));

  server.registerTool("bitable_v1_appTableRecord_search", {
    description: "查询多维表格数据表中的记录，支持筛选、排序和分页。",
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
      useUAT,
    },
  }, toolHandler(({ path, params, data, useUAT }) =>
    feishuRequest("POST", `/open-apis/bitable/v1/apps/${encodeURIComponent(path.app_token)}/tables/${encodeURIComponent(path.table_id)}/records/search`, { query: params, body: data || {}, useUAT })
  ));

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
      useUAT,
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
      useUAT,
    },
  }, toolHandler(({ path, params, data, useUAT }) =>
    feishuRequest("PUT", `/open-apis/bitable/v1/apps/${encodeURIComponent(path.app_token)}/tables/${encodeURIComponent(path.table_id)}/records/${encodeURIComponent(path.record_id)}`, { query: params, body: data, useUAT })
  ));

  server.registerTool("sheets_v3_spreadsheet_get", {
    description: "获取飞书电子表格元数据。spreadsheet_token 可由 wiki.getNode 返回的 obj_token 获得。",
    inputSchema: {
      path: z.object({ spreadsheet_token: z.string().min(1) }),
      useUAT,
    },
  }, toolHandler(({ path, useUAT }) =>
    feishuRequest("GET", `/open-apis/sheets/v3/spreadsheets/${encodeURIComponent(path.spreadsheet_token)}`, { useUAT })
  ));

  server.registerTool("sheets_v3_spreadsheetSheet_query", {
    description: "列出电子表格中的工作表，返回 sheet_id、标题和网格属性。",
    inputSchema: {
      path: z.object({ spreadsheet_token: z.string().min(1) }),
      useUAT,
    },
  }, toolHandler(({ path, useUAT }) =>
    feishuRequest("GET", `/open-apis/sheets/v3/spreadsheets/${encodeURIComponent(path.spreadsheet_token)}/sheets/query`, { useUAT })
  ));

  server.registerTool("sheets_v2_spreadsheetValues_get", {
    description: "读取电子表格单个范围的值。range 使用 <sheet_id>!A1:Z100；这里要填 sheet_id，不是工作表标题。",
    inputSchema: {
      path: z.object({ spreadsheet_token: z.string().min(1), range: z.string().min(1) }),
      params: z.object({
        valueRenderOption: z.string().optional(),
        dateTimeRenderOption: z.string().optional(),
        user_id_type: userIdType,
      }).optional(),
      useUAT,
    },
  }, toolHandler(({ path, params, useUAT }) =>
    feishuRequest("GET", `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(path.spreadsheet_token)}/values/${encodeURIComponent(path.range)}`, { query: params, useUAT })
  ));

  server.registerTool("sheets_v2_spreadsheetValues_update", {
    description: "向电子表格单个范围写入二维数组；覆盖该范围内已有内容。",
    inputSchema: {
      path: z.object({ spreadsheet_token: z.string().min(1) }),
      data: z.object({ valueRange: z.object({ range: z.string().min(1), values: z.array(z.array(z.any())) }) }),
      useUAT,
    },
  }, toolHandler(({ path, data, useUAT }) =>
    feishuRequest("PUT", `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(path.spreadsheet_token)}/values`, { body: data, useUAT })
  ));

  server.registerTool("sheets_v2_spreadsheetValues_append", {
    description: "从指定电子表格范围向后追加二维数组数据。",
    inputSchema: {
      path: z.object({ spreadsheet_token: z.string().min(1) }),
      params: z.object({ insertDataOption: z.string().optional() }).optional(),
      data: z.object({ valueRange: z.object({ range: z.string().min(1), values: z.array(z.array(z.any())) }) }),
      useUAT,
    },
  }, toolHandler(({ path, params, data, useUAT }) =>
    feishuRequest("POST", `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(path.spreadsheet_token)}/values_append`, { query: params, body: data, useUAT })
  ));

  return server;
}

const app = express();
app.use(express.json({ limit: "2mb" }));

const sessions = new Map();

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "feishu-render-mcp", version: "0.2.0", endpoint: "/mcp" });
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
  console.log(`Feishu MCP listening on 0.0.0.0:${PORT}/mcp`);
});
