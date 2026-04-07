# Feishu Codex Bridge

`Feishu Codex Bridge` receives Feishu bot messages over the official long connection API, binds a chat to a local workspace, selects a Codex Desktop thread, forwards user text into that thread, and replies back to Feishu with progress updates and the final answer.

## What it does

- Receive Feishu `im.message.receive_v1` events
- Bind a Feishu chat to a local workspace path
- Enumerate and switch existing Codex Desktop threads for that workspace
- Forward normal messages into the selected local Codex Desktop thread
- Stream progress text back into Feishu while the turn is running
- Persist chat-to-workspace/thread bindings in a local session file

## Supported commands

- `/codex bind /absolute/path`
- `/codex where`
- `/codex workspace`
- `/codex switch <threadId>`
- `/codex message`
- `/codex new`
- `/codex help`

After binding and selecting a thread, plain Feishu messages continue the active local Codex Desktop conversation.

## Architecture

```text
Feishu message
  -> Feishu long connection bot
  -> local session binding + workspace allowlist
  -> Codex Desktop state DB lookup
  -> Codex Desktop IPC start turn
  -> rollout/progress polling
  -> Feishu reply
```

## Requirements

- Node.js 22+
- A Feishu self-built app with bot capability
- A local Codex Desktop installation
- Access to the local Codex state database and IPC pipe on the same machine

## Environment

Copy `.env.example` to `.env` and fill in:

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`

Optional:

- `FEISHU_BOT_REPLY_IN_THREAD`
- `FEISHU_BOT_LOG_PAYLOADS`
- `FEISHU_BOT_RUNTIME_LOG_FILE`
- `CODEX_IM_WORKSPACE_ALLOWLIST`
- `CODEX_IM_SESSIONS_FILE`
- `CODEX_IM_CODEX_STATE_DB_PATH`
- `CODEX_IM_CODEX_DESKTOP_APP_PATH`
- `CODEX_IM_CODEX_TURN_TIMEOUT_MS`

Default local paths:

- Codex state DB: `~/.codex/state_5.sqlite`
- Session store: `~/.codex-im/sessions.json`

## Install

```bash
npm install
```

## Run

```bash
npm start
```

## Validate

1. Start the bridge locally.
2. Send `/codex help` to the Feishu bot.
3. Bind a workspace with `/codex bind /absolute/path`.
4. List or switch threads with `/codex switch`.
5. Send a plain message and confirm the reply comes from the selected local Codex Desktop thread.

## Notes

- `/codex new` depends on the local machine being able to open a native Codex Desktop thread programmatically. If that fails, create the thread in the desktop app first, then switch to it from Feishu.
- This project routes work into a local Codex Desktop session. It is not a general-purpose remote desktop tool.
