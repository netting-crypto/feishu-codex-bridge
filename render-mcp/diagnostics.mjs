// Only diagnostic metadata is retained; never include request bodies or headers.
export function redact(value, secrets = [], depth = 0) {
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") {
    let text = value;
    for (const secret of secrets.filter(Boolean)) text = text.split(secret).join("[REDACTED]");
    return text.replace(/Bearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]")
      .replace(/((?:access_token|refresh_token|app_secret|authorization|client_secret)=)[^&\s]+/gi, "$1[REDACTED]")
      .slice(0, 6000);
  }
  if (Array.isArray(value)) return value.slice(0, 50).map(item => redact(item, secrets, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) =>
    [key, /secret|authorization|access.?token|refresh.?token|password|cookie/i.test(key) ? "[REDACTED]" : redact(item, secrets, depth + 1)]));
  return value;
}

export function feishuError(response, payload, { method, path, appId, useUAT = false, secrets = [] }) {
  const diagnostic = redact({
    type: "feishu_api_error",
    http_status: response.status,
    code: payload?.code ?? null,
    msg: payload?.msg || response.statusText || "Unknown Feishu error",
    request: { method, path: path.split("?")[0], app_id: appId, identity: useUAT ? "user" : "tenant" },
    request_id: response.headers.get("x-request-id") || null,
    log_id: payload?.error?.log_id || payload?.log_id || response.headers.get("x-tt-logid") || null,
    error: payload?.error ?? null,
    permission_violations: payload?.permission_violations || payload?.permissionviolations || null,
  }, secrets);
  const error = new Error(JSON.stringify(diagnostic));
  error.diagnostic = diagnostic;
  return error;
}
