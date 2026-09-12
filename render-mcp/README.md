# Feishu MCP on Render

This directory deploys the official `@larksuiteoapi/lark-mcp` package as a remote Streamable HTTP MCP service on Render.

## Current scope

Only these Feishu tools are exposed:

- `wiki.v2.space.getNode`
- `bitable.v1.appTable.list`
- `bitable.v1.appTableField.list`
- `bitable.v1.appTableRecord.search`
- `bitable.v1.appTableRecord.create`
- `bitable.v1.appTableRecord.update`

No delete APIs are exposed.

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

The App ID is already configured as `cli_aae195540df8dd24`.

## Important security note

The official Lark MCP remote streamable mode does not itself provide client access control for this app-identity deployment. Do **not** treat a bare public `/mcp` endpoint with write tools as production-safe.

For the first connectivity test, keep the URL private and do not share it. Before long-term use, add an authentication layer (preferably MCP-compatible OAuth) or another trusted access-control layer supported by the ChatGPT MCP connection flow.

## Render free tier

Render Free Web Services can spin down after 15 minutes without inbound traffic. The next request wakes the service and may have a cold-start delay.

## Feishu-side requirement

The target Bitable must grant this Feishu application access, and the application's Open Platform permissions/version must include the required Wiki/Bitable APIs.
