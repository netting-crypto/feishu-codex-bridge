#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const require = createRequire(import.meta.url);
const lark = require('@larksuiteoapi/node-sdk');
const { DesktopCodexClient } = require('./codex-im/desktop-codex-client.cjs');
const { SessionStore } = require('./codex-im/session-store.cjs');
const { extractBindPath, extractSwitchThreadId, normalizeCommandText } = require('./codex-im/command-parsing.cjs');
const {
  filterThreadsByWorkspaceRoot,
  isAbsoluteWorkspacePath,
  isWorkspaceAllowed,
  normalizeWorkspacePath,
} = require('./codex-im/workspace-paths.cjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

loadEnv();

const config = readConfig();
const client = new lark.Client({
  appId: config.appId,
  appSecret: config.appSecret,
  appType: lark.AppType.SelfBuild,
  domain: lark.Domain.Feishu,
  loggerLevel: lark.LoggerLevel.info,
});
const wsClient = new lark.WSClient({
  appId: config.appId,
  appSecret: config.appSecret,
  appType: lark.AppType.SelfBuild,
  domain: lark.Domain.Feishu,
  loggerLevel: lark.LoggerLevel.info,
  wsConfig: {
    PingInterval: 30,
    PingTimeout: 5,
  },
});
const codex = new DesktopCodexClient({
  stateDbPath: config.codexStateDbPath,
  desktopAppPath: config.codexDesktopAppPath,
  turnTimeoutMs: config.codexTurnTimeoutMs,
});
const sessionStore = new SessionStore({ filePath: config.sessionsFile });
const messageStateById = new Map();

let codexReadyPromise = null;

startLongConnection();

function startLongConnection() {
  const eventDispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      await writeRuntimeLog('event:im.message.receive_v1');
      try {
        await handleTextEvent(data);
      } catch (error) {
        await writeRuntimeLog(`event_error:${formatError(error)}`);
        console.error(`[feishu-bot] failed to process message: ${formatError(error)}`);
      }
    },
  });

  wsClient.start({ eventDispatcher });
  void writeRuntimeLog('startup:long_connection_started');
  console.log('[feishu-bot] long connection started');
}

async function handleTextEvent(payload) {
  await writeRuntimeLog(`event_payload:${summarizeEventPayload(payload)}`);
  const message = normalizeFeishuTextEvent(payload);
  if (!message) {
    await writeRuntimeLog('event_ignored:normalize_returned_null');
    return;
  }

  const duplicateStatus = getMessageProcessingStatus(message.messageId);
  if (duplicateStatus === 'processing') {
    await writeRuntimeLog(`event_duplicate_inflight:${message.messageId}`);
    return;
  }
  if (duplicateStatus === 'completed') {
    await writeRuntimeLog(`event_duplicate_completed:${message.messageId}`);
    return;
  }
  markMessageProcessing(message.messageId);

  await writeRuntimeLog(`event_normalized:${message.messageId}:${message.command || 'plain'}:${truncateForLog(message.text, 120)}`);

  if (config.logPayloads) {
    await writeRuntimeLog(`inbound:${message.messageId}:${truncateForLog(message.text, 120)}`);
    console.log(`[feishu-bot] inbound ${message.messageId}: ${message.text}`);
  }

  try {
    if (message.command) {
      await writeRuntimeLog(`dispatch_command:${message.command}`);
      await dispatchCommand(message);
      await writeRuntimeLog(`dispatch_command_done:${message.command}`);
      return;
    }

    const bindingKey = sessionStore.buildBindingKey(message);
    const workspaceRoot = sessionStore.getActiveWorkspaceRoot(bindingKey);
    if (!workspaceRoot) {
      await writeRuntimeLog(`reply_missing_workspace:${message.messageId}`);
      await replyText(message, '当前会话还没有绑定项目。先发送 `/codex bind /绝对路径`。');
      return;
    }

    await ensureCodexReady();
    const threadId = await ensureThreadSelection(bindingKey, workspaceRoot, message, { allowCreate: false });
    await writeRuntimeLog(`thread_selected:${threadId}`);
    let lastProgressReply = '';
    const result = await codex.sendUserMessage({
      threadId,
      text: message.text,
      onProgress: async ({ text }) => {
        const progressText = normalizeText(text);
        if (!progressText || progressText === lastProgressReply) {
          return;
        }

        lastProgressReply = progressText;
        await writeRuntimeLog(`codex_progress:${threadId}:${truncateForLog(progressText, 160)}`);
        await replyText(message, progressText);
      },
    });

    await writeRuntimeLog(`codex_reply:${threadId}:${truncateForLog(result.replyText || '', 160)}`);
    const finalReplyText = result.replyText || '这一轮执行完成了，但没有拿到可展示的文本回复。';
    if (normalizeText(finalReplyText) !== lastProgressReply) {
      await replyText(message, finalReplyText);
    }
  } catch (error) {
    await writeRuntimeLog(`handle_error:${formatError(error)}`);
    await replyText(message, `处理失败：${formatError(error)}`);
    throw error;
  } finally {
    markMessageCompleted(message.messageId);
  }
}

async function dispatchCommand(message) {
  if (message.command === 'bind') {
    await handleBindCommand(message);
    return;
  }
  if (message.command === 'where') {
    await handleWhereCommand(message);
    return;
  }
  if (message.command === 'workspace') {
    await handleWorkspaceCommand(message);
    return;
  }
  if (message.command === 'new') {
    await handleNewCommand(message);
    return;
  }
  if (message.command === 'switch') {
    await handleSwitchCommand(message);
    return;
  }
  if (message.command === 'message') {
    await handleMessageCommand(message);
    return;
  }
  if (message.command === 'help') {
    await replyText(message, buildHelpText());
    return;
  }

  await replyText(message, '这条 `/codex` 命令当前还没有接上。先用 `/codex help` 查看可用命令。');
}

async function handleBindCommand(message) {
  const bindingKey = sessionStore.buildBindingKey(message);
  const rawWorkspaceRoot = extractBindPath(message.text);
  if (!rawWorkspaceRoot) {
    await replyText(message, '用法：`/codex bind /绝对路径`');
    return;
  }

  const workspaceRoot = normalizeWorkspacePath(rawWorkspaceRoot);
  if (!isAbsoluteWorkspacePath(workspaceRoot)) {
    await replyText(message, '只支持绝对路径绑定。Windows 例如 `E:\\repo`，macOS/Linux 例如 `/Users/name/repo`。');
    return;
  }
  if (!isWorkspaceAllowed(workspaceRoot, config.workspaceAllowlist)) {
    await replyText(message, '这个项目不在允许绑定的白名单里。');
    return;
  }

  const stats = await statWorkspace(workspaceRoot);
  if (!stats.exists) {
    await replyText(message, `项目不存在：${workspaceRoot}`);
    return;
  }
  if (!stats.isDirectory) {
    await replyText(message, `路径不是目录：${workspaceRoot}`);
    return;
  }

  sessionStore.setActiveWorkspaceRoot(bindingKey, workspaceRoot);
  await ensureCodexReady();
  const threads = await refreshWorkspaceThreads(bindingKey, workspaceRoot);
  const currentThreadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
  const selectionHint = currentThreadId
    ? `当前线程：${currentThreadId}`
    : threads.length > 1
      ? '当前项目下有多个线程。先发送 `/codex switch` 选择目标线程，避免消息误入其他对话。'
      : '当前还没有选中的线程。你可以发送 `/codex switch` 查看已有线程，或直接发普通消息尝试进入唯一线程。';
  const lines = [
    `已绑定项目：${workspaceRoot}`,
    selectionHint,
    `历史线程数：${threads.length}`,
  ];
  await replyText(message, lines.join('\n'));
}

async function handleWhereCommand(message) {
  const bindingKey = sessionStore.buildBindingKey(message);
  const workspaceRoot = sessionStore.getActiveWorkspaceRoot(bindingKey);
  if (!workspaceRoot) {
    await replyText(message, '当前会话还没有绑定项目。先发送 `/codex bind /绝对路径`。');
    return;
  }

  const threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
  await replyText(
    message,
    `当前项目：${workspaceRoot}\n当前线程：${threadId || '未选择'}`,
  );
}

async function handleWorkspaceCommand(message) {
  const bindingKey = sessionStore.buildBindingKey(message);
  const items = sessionStore.listBoundWorkspaces(bindingKey);
  if (!items.length) {
    await replyText(message, '当前会话还没有已绑定项目。先发送 `/codex bind /绝对路径`。');
    return;
  }

  const lines = ['当前已绑定项目：'];
  items.forEach((item) => {
    lines.push(
      `- ${item.isActive ? '[当前] ' : ''}${item.workspaceRoot}${item.threadId ? ` | thread: ${item.threadId}` : ''}`,
    );
  });
  await replyText(message, lines.join('\n'));
}

async function handleNewCommand(message) {
  const bindingKey = sessionStore.buildBindingKey(message);
  const workspaceRoot = sessionStore.getActiveWorkspaceRoot(bindingKey);
  if (!workspaceRoot) {
    await replyText(message, '当前会话还没有绑定项目。先发送 `/codex bind /绝对路径`。');
    return;
  }

  await ensureCodexReady();

  try {
    const response = await codex.startThread({ cwd: workspaceRoot });
    const threadId = normalizeIdentifier(response?.result?.thread?.id);
    if (!threadId) {
      throw new Error('桌面端没有返回新的线程 id');
    }

    sessionStore.setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId, buildBindingMetadata(message));
    await replyText(message, `已创建并切换到新线程：\n${threadId}`);
  } catch (error) {
    await replyText(
      message,
      `当前机器上还不能稳定自动新建原生线程：${formatError(error)}\n你可以先在桌面端手动新建线程，再回来用 \`/codex switch\` 切过去。`,
    );
  }
}

async function handleSwitchCommand(message) {
  const bindingKey = sessionStore.buildBindingKey(message);
  const workspaceRoot = sessionStore.getActiveWorkspaceRoot(bindingKey);
  if (!workspaceRoot) {
    await replyText(message, '当前会话还没有绑定项目。先发送 `/codex bind /绝对路径`。');
    return;
  }

  await ensureCodexReady();
  const threadId = extractSwitchThreadId(message.text);
  if (!threadId) {
    const threads = await refreshWorkspaceThreads(bindingKey, workspaceRoot);
    if (!threads.length) {
      await replyText(message, '当前项目下还没有可切换的历史线程。');
      return;
    }

    const lines = ['用法：`/codex switch <threadId>`', '', '可切换线程：'];
    threads.slice(0, 12).forEach((thread) => {
      lines.push(`- ${thread.id}${thread.title ? ` | ${thread.title}` : ''}`);
    });
    await replyText(message, lines.join('\n'));
    return;
  }

  const threads = await refreshWorkspaceThreads(bindingKey, workspaceRoot);
  const selected = threads.find((thread) => thread.id === threadId);
  if (!selected) {
    await replyText(message, '指定线程当前不在这个项目下。先发送 `/codex switch` 查看可用列表。');
    return;
  }

  sessionStore.setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId, buildBindingMetadata(message));
  await replyText(message, `已切换线程：${threadId}\n项目：${workspaceRoot}`);
}

async function handleMessageCommand(message) {
  const bindingKey = sessionStore.buildBindingKey(message);
  const workspaceRoot = sessionStore.getActiveWorkspaceRoot(bindingKey);
  if (!workspaceRoot) {
    await replyText(message, '当前会话还没有绑定项目。先发送 `/codex bind /绝对路径`。');
    return;
  }

  await ensureCodexReady();
  const threadId = await ensureThreadSelection(bindingKey, workspaceRoot, message, { allowCreate: false });
  const recentMessages = await codex.getRecentConversation({ threadId });
  if (!recentMessages.length) {
    await replyText(message, `当前线程：${threadId}\n还没有可展示的最近消息。`);
    return;
  }

  const lines = [`当前线程：${threadId}`, '最近消息：'];
  recentMessages.forEach((entry) => {
    lines.push('');
    lines.push(`${entry.role === 'assistant' ? '助手' : '用户'}：${entry.text}`);
  });
  await replyText(message, lines.join('\n'));
}

async function ensureCodexReady() {
  if (!codexReadyPromise) {
    codexReadyPromise = (async () => {
      await codex.connect();
      await codex.initialize();
      console.log('[feishu-bot] codex desktop bridge ready');
    })().catch((error) => {
      codexReadyPromise = null;
      throw error;
    });
  }

  return codexReadyPromise;
}

async function refreshWorkspaceThreads(bindingKey, workspaceRoot) {
  const allThreads = await codex.listThreads({ limit: 500, archived: false });
  const threads = filterThreadsByWorkspaceRoot(allThreads, workspaceRoot);
  const currentThreadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);

  if (!currentThreadId && threads.length === 1 && threads[0]?.id) {
    sessionStore.setThreadIdForWorkspace(bindingKey, workspaceRoot, threads[0].id);
  } else if (currentThreadId && !threads.some((thread) => thread.id === currentThreadId)) {
    sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
  }

  return threads;
}

async function ensureThreadSelection(bindingKey, workspaceRoot, message, { allowCreate = true } = {}) {
  let threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
  const threads = await refreshWorkspaceThreads(bindingKey, workspaceRoot);
  if (!threadId && threads.length === 1 && threads[0]?.id) {
    threadId = threads[0].id;
    sessionStore.setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId, buildBindingMetadata(message));
  }

  if (threadId) {
    return threadId;
  }

  if (threads.length > 1) {
    throw new Error('当前项目下有多个线程。先发送 `/codex switch` 选择目标线程，再继续发消息。');
  }

  if (!allowCreate) {
    throw new Error('当前项目还没有选中的线程。先发送 `/codex switch` 查看已有线程，或在桌面端新建后再切换。');
  }

  const response = await codex.startThread({ cwd: workspaceRoot });
  threadId = normalizeIdentifier(response?.result?.thread?.id);
  if (!threadId) {
    throw new Error('当前项目没有找到现成线程，而且桌面端自动新建线程没有成功');
  }

  sessionStore.setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId, buildBindingMetadata(message));
  return threadId;
}

async function replyText(message, text) {
  await sendTextReply({
    chatId: message.chatId,
    replyToMessageId: message.messageId,
    text,
  });
}

async function sendTextReply({ chatId, replyToMessageId = '', text }) {
  const content = JSON.stringify({ text });
  await writeRuntimeLog(`reply:${replyToMessageId || chatId}:${truncateForLog(text, 160)}`);

  if (replyToMessageId) {
    const replyMessage = resolveReplyMessageMethod(client);
    await replyMessage.call(client.im?.v1?.message || client.im?.message || client, {
      path: {
        message_id: normalizeMessageId(replyToMessageId),
      },
      data: {
        msg_type: 'text',
        content,
        reply_in_thread: config.replyInThread,
      },
    });
    return;
  }

  const createMessage = resolveCreateMessageMethod(client);
  await createMessage.call(client.im?.v1?.message || client.im?.message || client, {
    params: {
      receive_id_type: 'chat_id',
    },
    data: {
      receive_id: chatId,
      msg_type: 'text',
      content,
    },
  });
}

function normalizeFeishuTextEvent(payload) {
  const event = payload?.event && typeof payload.event === 'object'
    ? payload.event
    : payload;
  const message = event?.message;
  if (!message || message.message_type !== 'text') {
    return null;
  }

  if (event?.sender?.sender_type === 'app') {
    return null;
  }

  const content = safeParseJson(message.content);
  const text = sanitizeInboundText(typeof content?.text === 'string' ? content.text : '');
  if (!text) {
    return null;
  }

  return {
    workspaceId: config.defaultWorkspaceId,
    chatId: normalizeText(message.chat_id),
    chatType: normalizeText(message.chat_type),
    threadKey: normalizeText(message.root_id),
    senderId: normalizeText(event?.sender?.sender_id?.open_id || event?.sender?.sender_id?.user_id),
    messageId: normalizeText(message.message_id),
    text,
    command: parseCommand(text),
    sender: {
      senderType: normalizeText(event?.sender?.sender_type),
      openId: normalizeText(event?.sender?.sender_id?.open_id),
      unionId: normalizeText(event?.sender?.sender_id?.union_id),
      userId: normalizeText(event?.sender?.sender_id?.user_id),
    },
  };
}

function parseCommand(text) {
  const normalized = normalizeCommandText(text).trim().toLowerCase();
  if (normalized === '/codex where') return 'where';
  if (normalized === '/codex message') return 'message';
  if (normalized === '/codex help') return 'help';
  if (normalized === '/codex workspace') return 'workspace';
  if (normalized === '/codex new') return 'new';
  if (normalized === '/codex switch') return 'switch';
  if (normalized.startsWith('/codex bind ')) return 'bind';
  if (normalized.startsWith('/codex switch ')) return 'switch';
  if (normalized.startsWith('/codex')) return 'unknown_command';
  return '';
}

function buildHelpText() {
  return [
    '可用命令：',
    '/codex bind /绝对路径',
    '/codex where',
    '/codex workspace',
    '/codex new',
    '/codex switch <threadId>',
    '/codex message',
    '/codex help',
    '',
    '绑定项目后，直接发送普通消息，就会继续走当前桌面线程。',
  ].join('\n');
}

function buildBindingMetadata(message) {
  return {
    workspaceId: message.workspaceId,
    chatId: message.chatId,
    threadKey: message.threadKey,
    senderId: message.senderId,
  };
}

async function statWorkspace(workspaceRoot) {
  try {
    const stats = await fs.stat(workspaceRoot);
    return {
      exists: true,
      isDirectory: stats.isDirectory(),
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        exists: false,
        isDirectory: false,
      };
    }
    throw error;
  }
}

function resolveCreateMessageMethod(currentClient) {
  const fn = currentClient?.im?.v1?.message?.create || currentClient?.im?.message?.create;
  if (typeof fn !== 'function') {
    throw new Error('Unsupported Feishu SDK shape: missing message.create');
  }
  return fn;
}

function resolveReplyMessageMethod(currentClient) {
  const fn = currentClient?.im?.v1?.message?.reply || currentClient?.im?.message?.reply;
  if (typeof fn !== 'function') {
    throw new Error('Unsupported Feishu SDK shape: missing message.reply');
  }
  return fn;
}

function normalizeMessageId(messageId) {
  const normalized = normalizeText(messageId);
  if (!normalized) {
    return '';
  }
  return normalized.split(':')[0];
}

function readConfig() {
  const appId = requiredEnv('FEISHU_APP_ID');
  const appSecret = requiredEnv('FEISHU_APP_SECRET');

  return {
    appId,
    appSecret,
    defaultWorkspaceId: normalizeText(process.env.CODEX_IM_DEFAULT_WORKSPACE_ID) || 'default',
    workspaceAllowlist: String(process.env.CODEX_IM_WORKSPACE_ALLOWLIST || '')
      .split(',')
      .map((item) => normalizeText(item))
      .filter(Boolean),
    sessionsFile: normalizeText(process.env.CODEX_IM_SESSIONS_FILE)
      || path.join(os.homedir(), '.codex-im', 'sessions.json'),
    replyInThread: readBooleanEnv('FEISHU_BOT_REPLY_IN_THREAD', false),
    logPayloads: readBooleanEnv('FEISHU_BOT_LOG_PAYLOADS', false),
    codexStateDbPath: normalizeText(process.env.CODEX_IM_CODEX_STATE_DB_PATH)
      || path.join(os.homedir(), '.codex', 'state_5.sqlite'),
    codexDesktopAppPath: normalizeText(process.env.CODEX_IM_CODEX_DESKTOP_APP_PATH),
    codexTurnTimeoutMs: readNumberEnv('CODEX_IM_CODEX_TURN_TIMEOUT_MS', 10 * 60 * 1000),
    runtimeLogFile: normalizeText(process.env.FEISHU_BOT_RUNTIME_LOG_FILE)
      || path.join(projectRoot, 'feishu-codex-bridge.runtime.log'),
  };
}

function loadEnv() {
  const envCandidates = [
    path.join(projectRoot, '.env'),
    path.join(os.homedir(), '.codex-im', '.env'),
  ];

  envCandidates.forEach((envPath) => {
    dotenv.config({ path: envPath, override: false });
  });
}

function requiredEnv(name) {
  const value = normalizeText(process.env[name]);
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function readBooleanEnv(name, fallback) {
  const value = normalizeText(process.env[name]).toLowerCase();
  if (!value) {
    return fallback;
  }
  if (['1', 'true', 'yes', 'on'].includes(value)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(value)) {
    return false;
  }
  return fallback;
}

function readNumberEnv(name, fallback) {
  const raw = normalizeText(process.env[name]);
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sanitizeInboundText(value) {
  let normalized = normalizeText(value);
  if (!normalized) {
    return '';
  }

  normalized = normalized.replace(/^(@\S+\s+)+/u, '').trim();
  return normalized;
}

function normalizeIdentifier(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function safeParseJson(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function getMessageProcessingStatus(messageId) {
  pruneMessageStates();
  const entry = messageStateById.get(normalizeText(messageId));
  return entry?.status || '';
}

function markMessageProcessing(messageId) {
  const normalizedMessageId = normalizeText(messageId);
  if (!normalizedMessageId) {
    return;
  }

  pruneMessageStates();
  messageStateById.set(normalizedMessageId, {
    status: 'processing',
    updatedAt: Date.now(),
  });
}

function markMessageCompleted(messageId) {
  const normalizedMessageId = normalizeText(messageId);
  if (!normalizedMessageId) {
    return;
  }

  pruneMessageStates();
  messageStateById.set(normalizedMessageId, {
    status: 'completed',
    updatedAt: Date.now(),
  });
}

function pruneMessageStates() {
  const now = Date.now();
  for (const [messageId, entry] of messageStateById.entries()) {
    if (!entry || now - Number(entry.updatedAt || 0) > 30 * 60 * 1000) {
      messageStateById.delete(messageId);
    }
  }
}

function summarizeEventPayload(payload) {
  const event = payload?.event && typeof payload.event === 'object'
    ? payload.event
    : payload;
  const message = event?.message;
  return JSON.stringify({
    hasEvent: !!event,
    messageType: normalizeText(message?.message_type),
    messageId: normalizeText(message?.message_id),
    chatId: normalizeText(message?.chat_id),
    rootId: normalizeText(message?.root_id),
    senderType: normalizeText(event?.sender?.sender_type),
  });
}

async function writeRuntimeLog(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    await fs.mkdir(path.dirname(config.runtimeLogFile), { recursive: true });
    await fs.appendFile(config.runtimeLogFile, line, 'utf8');
  } catch {
    // Ignore logging failures so the bot path stays intact.
  }
}

function truncateForLog(value, maxLength) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}
