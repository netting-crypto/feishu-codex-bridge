# Feishu MCP on Render

This directory deploys a small Streamable HTTP MCP service on Render. It keeps the existing Wiki/Bitable surface and adds direct Feishu Sheets OpenAPI tools because the pinned official MCP package does not expose the spreadsheet range operations we need.

## Current scope

Only these Feishu tools are exposed:

- `wiki.v2.space.getNode`
- `bitable.v1.appTable.list`
- `bitable.v1.appTable.create`
- `bitable.v1.appTableField.list`
- `bitable.v1.appTableField.create`
- `bitable.v1.appTableField.update`
- `bitable.v1.appTableRecord.search`
- `bitable.v1.appTableRecord.create`
- `bitable.v1.appTableRecord.update`
- `bitable.v1.appTableRecord.batchCreate`
- `bitable.v1.appTableRecord.batchUpdate`

It also exposes these normal-Sheets tools:

- `sheets_v3_spreadsheet_get`
- `sheets_v3_spreadsheetSheet_query`
- `sheets_v2_spreadsheetValues_get`
- `sheets_v2_spreadsheetValues_update`
- `sheets_v2_spreadsheetValues_append`

No delete APIs are exposed. Schema creation is intentionally create/update-only so automation can provision new CRM tables without gaining destructive table or field deletion capabilities.

For a Wiki-backed Sheet, call `wiki_v2_space_getNode` first and use its `obj_token` as `spreadsheet_token`. Use `sheets_v3_spreadsheetSheet_query` to resolve a worksheet `sheet_id`, then ranges use the form `<sheet_id>!A1:Z100`.

## Deploy on Render

1. Open Render Dashboard.
2. Choose **New > Blueprint**.
3. Connect `netting-crypto/feishu-codex-bridge`.
4. Choose branch `cloud-mcp-render`.
5. Set **Blueprint Path** to `render-mcp/render.yaml`.
6. Render will ask for the secret environment variable `APP_SECRET`. Paste the Feishu App Secret there only.
7. Deploy the Blueprint.
8. After the service is live, the MCP endpoint will be:

   `https://<service-name>.onrender.com/mcp`

The App ID is already configured as `cli_aae195540df8dd24`. `APP_SECRET` remains a Render-only secret.

## MCP client authentication

Production entrypoint: `server-compat.mjs`. Both `npm start` and Docker use this
entrypoint; `npm run check` and `npm test` cover it. Health at `/` includes the
Render commit so the live workload can be matched with GitHub.

All methods on `/mcp` require OAuth. Missing authentication configuration denies
access with HTTP 503. A missing/invalid token returns HTTP 401 with protected
resource discovery. Existing unauthenticated connections must be reconnected
using OAuth after rollout; never disable authentication to restore a connection.

This is a single-owner confidential OAuth client using the MCP SDK's authorization
code + S256 PKCE flow, strict callback allowlist, owner login/consent, one-use codes,
short-lived access tokens and client-authenticated refresh tokens. Tokens are
bound to issuer, `/mcp` audience and `feishu:tools` scope. Credentials and signing
key remain in Render environment variables so access/refresh tokens survive
restarts. Pending login/code exchanges are memory-only; reconnect if a deploy
interrupts login. Refresh tokens expire absolutely after 30 days. Rotate
`MCP_OAUTH_SIGNING_KEY` and redeploy to revoke all existing grants. This deployment
is for one trusted owner; a multi-user service needs an external identity provider
and per-user Feishu authorization.

Required Render configuration (merge these keys, preserve `APP_SECRET`):

| Key | Value |
| --- | --- |
| `MCP_PUBLIC_URL` | `https://feishu-mcp-qr4u.onrender.com` |
| `MCP_OAUTH_CLIENT_ID` | `feishu-gtd-chatgpt` |
| `MCP_OAUTH_CLIENT_SECRET` | Independent random secret, at least 32 characters |
| `MCP_OWNER_PASSWORD` | Independent random owner login password, at least 32 characters |
| `MCP_OAUTH_SIGNING_KEY` | Independent random signing key, at least 32 characters |
| `MCP_OAUTH_REDIRECT_URIS` | Exact ChatGPT callback URL(s), comma-separated |

The Blueprint generates missing secret values. An existing service not managed by
Blueprints must receive these keys through Render environment configuration
before deploying this version. Do not write credentials to source or URLs.

In ChatGPT's custom MCP connection, keep the same `/mcp` URL, select OAuth,
set client ID `feishu-gtd-chatgpt` and use the `MCP_OAUTH_CLIENT_SECRET` value from
Render. The authorization page asks for `MCP_OWNER_PASSWORD`, not the Feishu
password/App Secret. Never paste these values into a chat. The server advertises
RFC 9207 issuer identification and defaults to ChatGPT's stable callback
`https://chatgpt.com/connector_platform_oauth_redirect`. Verify the exact callback
shown in ChatGPT's connection management; add it to the allowlist if different.

## Feishu error diagnosis

Errors retain `http_status`, Feishu `code`/`msg`, HTTP method/path, App ID,
`tenant`/`user` identity, response request/log ID and returned permission hints.
Request bodies, query strings, response data and authorization headers are not
logged. Known credentials and sensitive diagnostic keys are redacted; non-JSON
response bodies are never echoed. `server_diagnostics` returns non-secret runtime
configuration only after MCP authentication.

Do not infer write access from a successful read. Feishu error `99991672` means
an API scope issue; `91403` means the current identity lacks document permissions.
For tenant identity, open the target document's **... > More > Add document app**,
find application **gpt** (`cli_aae195540df8dd24`) and grant editing for the intended
test document. If advanced permissions are enabled, consult Feishu's requirement
for application management access before broadening authorization. Preserve
existing users, records and permissions. Re-run reads and a same-value update
before a temporary marker test. Do not create test records until a verified
cleanup route exists; this MCP deliberately does not expose delete APIs.

Official references:
- https://open.feishu.cn/document/server-docs/api-call-guide/generic-error-code
- https://developers.openai.com/plugins/build/auth

## Render free tier

Render Free Web Services can spin down after 15 minutes without inbound traffic. The next request wakes the service and may have a cold-start delay.

## Feishu-side requirement

The target Bitable must grant this Feishu application access, and the application's Open Platform permissions/version must include the required Wiki/Bitable APIs.
