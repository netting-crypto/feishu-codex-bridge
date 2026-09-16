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
const CAREERSAIL_FULL_SYSTEM_SENTINEL = "__careersail_provision_full_system_v1__";
const CAREERSAIL_COMPANY_POOL_V4_SYNC_SENTINEL = "__careersail_sync_company_pool_v4__";
const CAREERSAIL_TARGET_APP_TOKEN = "I7RlbWkZ6a4QvBs5DjdcAAdJn6b";
const CAREERSAIL_TARGET_COMPANY_TABLE_ID = "tblIHcNm1dkSVgrA";

const CAREERSAIL_COMPANY_POOL_V4 = `
抖音体验与服务团队
剪映CapCut
懂车帝
字节跳动 GMPT
腾讯金融科技
腾讯营销
阿里健康
阿里云瓴羊
高德地图
盒马
小红书
快手
DeepSeek
商汤科技
中电信人工智能科技(北京)有限公司
汽车之家
镁信健康
卫宁健康
信雅达
帆软
韶音科技
中国平安
泰康保险
小米集团
OPPO
vivo
雷鸟科技
大疆
京东
TCL
中国移动
科大讯飞
荣耀
小鹏汽车
安克创新
传音控股
海信
联想
海尔
九号公司
正浩EcoFlow
智岩科技
拓竹科技
歌尔股份
贝泰妮
思必驰
作业帮
babycare
森马
新中大科技
广电运通
新华三
博思软件
万兴科技
Shopee虾皮
转转
迅雷网络
心动×TapTap
新浪微博
哔哩哔哩
网易
美团
百度
度小满
沐瞳科技
e签宝
合合信息
金蝶
得物
三七互娱
数坤科技
Sea
去哪儿
阿里云
TCL华星
淘天集团
蚂蚁集团
阿里国际
携程
京东健康
水滴公司
联影医疗
迈瑞医疗
讯飞医疗
平安健康
蔚来
理想
元戎启行
卓驭
新石器无人车
千里科技
九识智能
优必选科技
普渡机器人
星尘智能
乐动机器人
海柔创新
奥比中光
RoboSense
禾赛科技
它石智航
佑驾创新
北京发那科
亿联网络
天翼云
浩鲸科技
海大集团
亚信安全
亿道集团
三一集团
安踏
春秋航空
新大陆科技集团
图拉斯
杉川集团
致欧家居
认养一头牛
北京国能日新
海艺互娱
招商银行信用卡中心
`.trim().split("\n");

const CAREERSAIL_ALREADY_APPLIED = new Set([
  "字节跳动 GMPT", "中国平安", "安克创新", "传音控股", "海信", "贝泰妮", "网易", "美团", "百度", "度小满",
  "沐瞳科技", "e签宝", "合合信息", "金蝶", "得物", "三七互娱", "数坤科技", "Sea", "去哪儿", "理想",
  "元戎启行", "卓驭", "海艺互娱", "招商银行信用卡中心",
]);
const CAREERSAIL_FOLLOW_UP = new Set(["中国平安", "安克创新", "招商银行信用卡中心"]);
const CAREERSAIL_CHECK_JOB = new Set([
  "TCL", "荣耀", "联想", "海尔", "TCL华星", "淘天集团", "蚂蚁集团", "阿里国际", "携程", "京东健康",
  "水滴公司", "联影医疗", "迈瑞医疗", "讯飞医疗", "平安健康", "蔚来", "禾赛科技",
]);

const CAREERSAIL_HEALTHCARE = new Set([
  "阿里健康", "镁信健康", "卫宁健康", "中国平安", "泰康保险", "贝泰妮", "数坤科技", "京东健康", "水滴公司",
  "联影医疗", "迈瑞医疗", "讯飞医疗", "平安健康", "科大讯飞",
]);
const CAREERSAIL_CONSUMER_TECH = new Set([
  "小米集团", "OPPO", "vivo", "雷鸟科技", "大疆", "荣耀", "安克创新", "传音控股", "海信", "联想", "海尔", "TCL",
  "TCL华星", "九号公司", "正浩EcoFlow", "智岩科技", "拓竹科技", "歌尔股份", "奥比中光", "倍思奇",
]);
const CAREERSAIL_ROBOTICS = new Set([
  "小鹏汽车", "蔚来", "理想", "元戎启行", "卓驭", "新石器无人车", "千里科技", "九识智能", "优必选科技", "普渡机器人",
  "星尘智能", "乐动机器人", "海柔创新", "RoboSense", "禾赛科技", "它石智航", "佑驾创新", "北京发那科",
]);
const CAREERSAIL_ENTERPRISE = new Set([
  "信雅达", "帆软", "金蝶", "阿里云", "阿里云瓴羊", "中电信人工智能科技(北京)有限公司", "新华三", "博思软件", "新中大科技",
  "亚信安全", "天翼云", "浩鲸科技", "广电运通", "亿道集团", "三一集团", "新大陆科技集团",
]);
const CAREERSAIL_FINTECH = new Set(["腾讯金融科技", "度小满", "蚂蚁集团", "东方财富", "嘉实基金", "招商银行信用卡中心"]);

function careerSailCanonicalCompanyKey(name) {
  return `company:${String(name || "").normalize("NFKC").trim().toLowerCase()}`;
}

function careerSailIndustryTag(name) {
  if (CAREERSAIL_HEALTHCARE.has(name)) return ["HEALTHCARE_AI"];
  if (CAREERSAIL_CONSUMER_TECH.has(name)) return ["CONSUMER_TECH"];
  if (CAREERSAIL_ROBOTICS.has(name)) return ["ROBOTICS"];
  if (CAREERSAIL_ENTERPRISE.has(name)) return ["ENTERPRISE_SOFTWARE", "AI_SOFTWARE"];
  if (CAREERSAIL_FINTECH.has(name)) return ["FINTECH"];
  return ["INTERNET", "AI_SOFTWARE"];
}

function careerSailAction(name) {
  if (CAREERSAIL_FOLLOW_UP.has(name)) return "FOLLOW_UP";
  if (CAREERSAIL_ALREADY_APPLIED.has(name) || CAREERSAIL_CHECK_JOB.has(name)) return "CHECK_JOB";
  return "APPLY";
}

function careerSailReason(name, rank, action) {
  const industry = CAREERSAIL_HEALTHCARE.has(name)
    ? "医疗AI/数字健康重点方向"
    : CAREERSAIL_CONSUMER_TECH.has(name)
      ? "AI终端/智能硬件软件体验重点方向"
      : CAREERSAIL_ROBOTICS.has(name)
        ? "智能汽车/机器人软件产品邻接方向"
        : CAREERSAIL_ENTERPRISE.has(name)
          ? "AI应用/业务工具/企业软件方向"
          : "AI应用产品/Agent/产品策略相关方向";
  const timing = rank <= 30 ? "流程慢或机会强，优先处理" : rank <= 60 ? "高匹配，第二批覆盖" : rank <= 90 ? "匹配明确，9月20日前覆盖" : "扩展池，9月21日前尽量覆盖";
  if (action === "FOLLOW_UP") return `已进入流程；${industry}；${timing}`;
  if (action === "CHECK_JOB") return `公司值得继续覆盖；${industry}；先查当前可投岗位/多投限制；${timing}`;
  return `2027秋招候选；${industry}；${timing}`;
}

function careerSailTextValue(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => item?.text ?? item?.name ?? item ?? "").join("").trim();
  if (value && typeof value === "object") return value.text || value.name || "";
  return value == null ? "" : String(value);
}

async function syncCareerSailCompanyPoolV4(appToken, useUAT) {
  if (appToken !== CAREERSAIL_TARGET_APP_TOKEN) {
    throw new Error("CareerSail V4 sync is restricted to the configured target Base");
  }
  const recordsPath = `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(CAREERSAIL_TARGET_COMPANY_TABLE_ID)}/records`;
  const current = await feishuRequest("POST", `${recordsPath}/search`, {
    query: { page_size: 500 },
    body: { field_names: ["公司", "company_key"] },
    useUAT,
  });
  const existing = current.items || [];
  const byKey = new Map();
  const byName = new Map();
  for (const record of existing) {
    const key = careerSailTextValue(record.fields?.company_key);
    const name = careerSailTextValue(record.fields?.["公司"]);
    if (key) byKey.set(key, record);
    if (name) byName.set(name.trim().toLowerCase(), record);
  }

  const now = Date.now();
  const creates = [];
  const updates = [];
  const actionCounts = { APPLY: 0, CHECK_JOB: 0, FOLLOW_UP: 0 };
  for (let index = 0; index < CAREERSAIL_COMPANY_POOL_V4.length; index += 1) {
    const name = CAREERSAIL_COMPANY_POOL_V4[index];
    const rank = index + 1;
    const action = careerSailAction(name);
    actionCounts[action] += 1;
    const priority = rank <= 60 ? "P0" : rank <= 100 ? "P1" : "P2";
    const match = rank <= 30 ? 95 : rank <= 60 ? 90 : rank <= 90 ? 84 : 78;
    const score = rank <= 30 ? 94 : rank <= 60 ? 89 : rank <= 90 ? 83 : 76;
    const fields = {
      "公司": name,
      company_key: careerSailCanonicalCompanyKey(name),
      "行业标签": careerSailIndustryTag(name),
      "发现来源": ["MANUAL"],
      "招聘批次": "2027秋招｜V4执行榜｜2026-09-16",
      "27届招聘状态": "OPEN",
      "岗位获取状态": CAREERSAIL_CHECK_JOB.has(name) ? "NOT_CHECKED" : "FOUND",
      "岗位数": CAREERSAIL_CHECK_JOB.has(name) ? 0 : 1,
      "公司匹配度": match,
      "综合分": score,
      "公司排名": rank,
      "优先级": priority,
      "今日动作": action,
      "为什么现在投": careerSailReason(name, rank, action),
      "内推覆盖": "NOT_CHECKED",
      "系统更新时间": now,
    };
    const key = fields.company_key;
    const found = byKey.get(key) || byName.get(name.trim().toLowerCase());
    if (found?.record_id) updates.push({ record_id: found.record_id, fields });
    else creates.push({ fields });
  }

  const chunks = (items, size = 500) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size));
  for (const records of chunks(creates)) {
    if (!records.length) continue;
    await feishuRequest("POST", `${recordsPath}/batch_create`, { body: { records }, useUAT });
  }
  for (const records of chunks(updates)) {
    if (!records.length) continue;
    await feishuRequest("POST", `${recordsPath}/batch_update`, { body: { records }, useUAT });
  }

  const verify = await feishuRequest("POST", `${recordsPath}/search`, {
    query: { page_size: 500 },
    body: {
      field_names: ["公司", "company_key", "招聘批次", "公司排名", "优先级", "今日动作"],
      sort: [{ field_name: "公司排名", desc: false }],
    },
    useUAT,
  });
  const targetKeys = new Set(CAREERSAIL_COMPANY_POOL_V4.map(careerSailCanonicalCompanyKey));
  const verified = (verify.items || []).filter((record) => targetKeys.has(careerSailTextValue(record.fields?.company_key)));
  return {
    careersail_company_pool_v4: {
      target_table: CAREERSAIL_TARGET_COMPANY_TABLE_ID,
      ranked: CAREERSAIL_COMPANY_POOL_V4.length,
      created: creates.length,
      updated: updates.length,
      verified: verified.length,
      action_counts: actionCounts,
      top_10: verified.slice(0, 10).map((record) => ({ record_id: record.record_id, fields: record.fields })),
      human_fields_preserved: true,
    },
  };
}

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

const CAREERSAIL_SOURCE_OPTIONS = ["PAPERBALL", "OFFICIAL_ATS", "XHS", "QQ", "CAREER_FAIR", "MANUAL"];
const CAREERSAIL_STAGE_OPTIONS = ["RESUME_SCREENING", "ASSESSMENT", "WRITTEN_TEST", "AI_INTERVIEW", "INTERVIEW_1", "INTERVIEW_2", "INTERVIEW_3", "HR", "OFFER"];
const CAREERSAIL_RESULT_OPTIONS = ["PENDING", "PASS", "FAIL"];

function relationField(field_name, table_id, multiple = false) {
  return { field_name, type: 18, property: { table_id, multiple } };
}

function careerSailJobFields(companyTableId) {
  const result = [
    { field_name: "job_key", type: 1 },
    relationField("公司", companyTableId, false),
    { field_name: "公司名", type: 1 },
    { field_name: "provider", type: 1 },
    { field_name: "job_id", type: 1 },
    { field_name: "来源", type: 3, property: selectProperty(CAREERSAIL_SOURCE_OPTIONS) },
    { field_name: "岗位方向", type: 1 },
    { field_name: "部门/业务线", type: 1 },
    { field_name: "城市", type: 1 },
    { field_name: "JD", type: 1 },
    { field_name: "岗位链接", type: 15 },
    { field_name: "开放状态", type: 3, property: selectProperty(["UNKNOWN", "OPEN", "CLOSED", "CLOSED_RISK"]) },
    { field_name: "岗位开放时间", type: 5 },
    { field_name: "岗位截止时间", type: 5 },
    { field_name: "岗位匹配分", type: 2 },
    { field_name: "岗位匹配档", type: 1 },
    { field_name: "可投性", type: 3, property: selectProperty(["CAN_APPLY", "NEEDS_VERIFY", "REJECT"]) },
    { field_name: "匹配理由", type: 1 },
    { field_name: "风险项", type: 1 },
    { field_name: "投递状态", type: 3, property: selectProperty(["NOT_APPLIED", "ACTIVE", "WITHDRAWN", "REJECTED", "OFFERED", "ACCEPTED"]) },
    { field_name: "投递时间", type: 5 },
    { field_name: "当前阶段", type: 3, property: selectProperty(CAREERSAIL_STAGE_OPTIONS) },
    { field_name: "当前阶段结果", type: 3, property: selectProperty(CAREERSAIL_RESULT_OPTIONS) },
    { field_name: "下一步", type: 1 },
    { field_name: "投递备注", type: 1 },
    { field_name: "legacy_note", type: 1 },
    { field_name: "系统更新时间", type: 5 },
  ];
  const labels = {
    RESUME_SCREENING: "简历",
    ASSESSMENT: "测评",
    WRITTEN_TEST: "笔试",
    AI_INTERVIEW: "AI面试",
    INTERVIEW_1: "一面",
    INTERVIEW_2: "二面",
    INTERVIEW_3: "三面/业务终面",
    HR: "HR面",
    OFFER: "Offer",
  };
  for (const stage of CAREERSAIL_STAGE_OPTIONS) {
    result.push({ field_name: `${labels[stage]}结果`, type: 3, property: selectProperty(CAREERSAIL_RESULT_OPTIONS) });
    result.push({ field_name: `${labels[stage]}时间`, type: 5 });
  }
  return result;
}

function careerSailIntelFields(companyTableId, jobTableId) {
  return [
    { field_name: "intel_key", type: 1 },
    relationField("公司", companyTableId, false),
    { field_name: "公司名", type: 1 },
    relationField("岗位", jobTableId, false),
    { field_name: "情报类型", type: 3, property: selectProperty(["REFERRAL_CODE", "REFERRAL_LINK", "JOB_OPENING", "DEADLINE", "WRITTEN_TEST_PROGRESS", "INTERVIEW_PROGRESS", "CAREER_FAIR", "HR_CONTACT", "APPLICATION_TIP", "TIMING_SIGNAL", "OTHER"]) },
    { field_name: "来源", type: 3, property: selectProperty(CAREERSAIL_SOURCE_OPTIONS) },
    { field_name: "来源名称", type: 1 },
    { field_name: "来源记录ID", type: 1 },
    { field_name: "来源链接", type: 15 },
    { field_name: "发布时间", type: 5 },
    { field_name: "采集时间", type: 5 },
    { field_name: "情报内容", type: 1 },
    { field_name: "内推码", type: 1 },
    { field_name: "内推链接", type: 15 },
    { field_name: "适用届别", type: 2 },
    { field_name: "适用批次", type: 1 },
    { field_name: "适用范围", type: 1 },
    { field_name: "有效性", type: 3, property: selectProperty(["UNVERIFIED", "ACTIVE", "VERIFIED", "STALE", "INVALID", "EXPIRED", "REVOKED"]) },
    { field_name: "置信度", type: 2 },
    { field_name: "失效时间", type: 5 },
    { field_name: "系统更新时间", type: 5 },
  ];
}

async function ensureCareerSailTable(appToken, useUAT, { name, primaryFieldName, fields }) {
  const tablesPath = `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables`;
  let tableList = await feishuRequest("GET", tablesPath, { query: { page_size: 100 }, useUAT });
  let table = (tableList.items || []).find((item) => item.name === name);
  let created = false;
  if (!table) {
    await feishuRequest("POST", `${tablesPath}/batch_create`, { body: { tables: [{ name }] }, useUAT });
    tableList = await feishuRequest("GET", tablesPath, { query: { page_size: 100 }, useUAT });
    table = (tableList.items || []).find((item) => item.name === name);
    created = true;
  }
  if (!table?.table_id) throw new Error(`CareerSail provisioning failed to resolve ${name} table_id`);

  const fieldsPath = `${tablesPath}/${encodeURIComponent(table.table_id)}/fields`;
  let fieldList = await feishuRequest("GET", fieldsPath, { query: { page_size: 100 }, useUAT });
  let existingFields = fieldList.items || [];
  const primary = existingFields.find((field) => field.is_primary);
  if (!primary) throw new Error(`CareerSail ${name} has no primary field`);
  if (primary.field_name !== primaryFieldName) {
    await feishuRequest("PUT", `${fieldsPath}/${encodeURIComponent(primary.field_id)}`, {
      body: { field_name: primaryFieldName, type: primary.type, ...(primary.property ? { property: primary.property } : {}) },
      useUAT,
    });
    fieldList = await feishuRequest("GET", fieldsPath, { query: { page_size: 100 }, useUAT });
    existingFields = fieldList.items || [];
  }

  const existingByName = new Map(existingFields.map((field) => [field.field_name, field]));
  const addedFields = [];
  for (const field of fields) {
    const existing = existingByName.get(field.field_name);
    if (existing) {
      if (existing.type !== field.type) throw new Error(`CareerSail ${name} field type conflict: ${field.field_name} existing=${existing.type} desired=${field.type}`);
      continue;
    }
    await feishuRequest("POST", fieldsPath, { body: field, useUAT });
    addedFields.push(field.field_name);
  }
  const finalFields = await feishuRequest("GET", fieldsPath, { query: { page_size: 100 }, useUAT });
  return { name, table_id: table.table_id, created, added_fields: addedFields, total_fields: (finalFields.items || []).length };
}

async function provisionCareerSailFullSystem(appToken, useUAT) {
  const companyResult = await provisionCareerSailCompanyPool(appToken, useUAT);
  const companyTableId = companyResult.careersail_provision.table_id;
  const jobs = await ensureCareerSailTable(appToken, useUAT, {
    name: "岗位投递",
    primaryFieldName: "岗位",
    fields: careerSailJobFields(companyTableId),
  });
  const intelligence = await ensureCareerSailTable(appToken, useUAT, {
    name: "情报内推",
    primaryFieldName: "情报摘要",
    fields: careerSailIntelFields(companyTableId, jobs.table_id),
  });

  const companyFieldsPath = `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(companyTableId)}/fields`;
  const companyFieldList = await feishuRequest("GET", companyFieldsPath, { query: { page_size: 100 }, useUAT });
  const companyFields = companyFieldList.items || [];
  const primaryJob = companyFields.find((field) => field.field_name === "主推岗位");
  if (!primaryJob) {
    await feishuRequest("POST", companyFieldsPath, { body: relationField("主推岗位", jobs.table_id, false), useUAT });
  } else if (primaryJob.type !== 18) {
    throw new Error(`CareerSail 公司池 field type conflict: 主推岗位 existing=${primaryJob.type} desired=18`);
  }

  const finalTables = await feishuRequest("GET", `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables`, { query: { page_size: 100 }, useUAT });
  return {
    careersail_full_system: {
      original_tables_preserved: true,
      company_pool: companyResult.careersail_provision,
      jobs,
      intelligence,
      tables: (finalTables.items || []).map(({ name, table_id }) => ({ name, table_id })),
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
    if (params?.page_token === CAREERSAIL_COMPANY_POOL_V4_SYNC_SENTINEL) {
      return syncCareerSailCompanyPoolV4(path.app_token, useUAT);
    }
    if (params?.page_token === CAREERSAIL_FULL_SYSTEM_SENTINEL) {
      return provisionCareerSailFullSystem(path.app_token, useUAT);
    }
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
