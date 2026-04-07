const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { DesktopIpcClient } = require('./desktop-ipc-client.cjs');
const { normalizeWorkspacePath } = require('./workspace-paths.cjs');

const DEFAULT_CODEX_HOME = path.join(os.homedir(), '.codex');
const DEFAULT_STATE_DB_PATH = path.join(DEFAULT_CODEX_HOME, 'state_5.sqlite');
const DEFAULT_NEW_THREAD_TIMEOUT_MS = 15000;
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 700;

class DesktopCodexClient {
  constructor({
    stateDbPath = DEFAULT_STATE_DB_PATH,
    ipcPipePath,
    desktopAppPath = '',
    newThreadTimeoutMs = DEFAULT_NEW_THREAD_TIMEOUT_MS,
    turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
  } = {}) {
    this.stateDbPath = stateDbPath;
    this.desktopAppPath = desktopAppPath;
    this.newThreadTimeoutMs = newThreadTimeoutMs;
    this.turnTimeoutMs = turnTimeoutMs;
    this.ipc = new DesktopIpcClient({ pipePath: ipcPipePath });
    this.database = null;
  }

  async connect() {
    await this.ipc.connect();
    this.getDatabase();
  }

  async initialize() {
    await this.ipc.initialize();
  }

  close() {
    this.ipc.close();
    if (this.database) {
      this.database.close();
      this.database = null;
    }
  }

  async listThreads({ limit = 200, archived = false } = {}) {
    const database = this.getDatabase();
    const statement = database.prepare(`
      SELECT
        id,
        cwd,
        title,
        first_user_message,
        updated_at,
        archived,
        rollout_path
      FROM threads
      WHERE archived = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `);

    return statement.all(archived ? 1 : 0, limit).map(normalizeThreadRow);
  }

  async sendUserMessage({ threadId, text, onProgress }) {
    const thread = this.getThreadById(threadId);
    if (!thread) {
      throw new Error(`Codex thread not found: ${threadId}`);
    }
    if (!thread.rolloutPath) {
      throw new Error(`Codex thread is missing rollout path: ${threadId}`);
    }

    const watcher = createRolloutWatcher(thread.rolloutPath, {
      expectedUserText: text,
      onProgress,
    });
    await this.ipc.startTurn({
      conversationId: threadId,
      text,
    });

    const completion = await watcher.waitForCompletion(this.turnTimeoutMs);
    return {
      threadId,
      replyText: completion.replyText,
    };
  }

  async getRecentConversation({ threadId, turnLimit = 3 } = {}) {
    const thread = this.getThreadById(threadId);
    if (!thread?.rolloutPath) {
      return [];
    }

    let content = '';
    try {
      content = await fsp.readFile(thread.rolloutPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    const messages = [];
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const entry = safeParseJson(line);
      if (!entry || entry.type !== 'event_msg') {
        continue;
      }

      if (entry.payload?.type === 'user_message') {
        const text = normalizeMessageText(entry.payload.message);
        if (text) {
          messages.push({ role: 'user', text });
        }
      }

      if (entry.payload?.type === 'agent_message') {
        const text = normalizeMessageText(entry.payload.message);
        if (text) {
          messages.push({ role: 'assistant', text });
        }
      }
    }

    const deduped = dedupeConversationMessages(messages);
    return deduped.slice(-(turnLimit * 2));
  }

  async startThread({ cwd }) {
    const normalizedCwd = normalizeWorkspacePath(cwd);
    if (!normalizedCwd) {
      throw new Error('A workspace path is required to create a Codex desktop thread');
    }

    const existingIds = new Set(
      (await this.listThreads({ limit: 500, archived: false }))
        .filter((thread) => normalizeWorkspacePath(thread.cwd) === normalizedCwd)
        .map((thread) => thread.id),
    );

    await launchDesktopNewThread({
      cwd: normalizedCwd,
      desktopAppPath: this.desktopAppPath,
    });

    const startedAt = Date.now();
    while (Date.now() - startedAt < this.newThreadTimeoutMs) {
      const threads = await this.listThreads({ limit: 500, archived: false });
      const createdThread = threads.find((thread) => (
        normalizeWorkspacePath(thread.cwd) === normalizedCwd
        && !existingIds.has(thread.id)
      ));

      if (createdThread) {
        return {
          result: {
            thread: {
              id: createdThread.id,
            },
          },
        };
      }

      await delay(POLL_INTERVAL_MS);
    }

    throw new Error('Codex Desktop did not create a new native thread automatically on this machine');
  }

  getThreadById(threadId) {
    const database = this.getDatabase();
    const statement = database.prepare(`
      SELECT
        id,
        cwd,
        title,
        first_user_message,
        updated_at,
        archived,
        rollout_path
      FROM threads
      WHERE id = ?
      LIMIT 1
    `);

    const row = statement.get(threadId);
    return row ? normalizeThreadRow(row) : null;
  }

  getDatabase() {
    if (!this.database) {
      this.database = new DatabaseSync(this.stateDbPath, {
        open: true,
        readOnly: true,
      });
    }

    return this.database;
  }
}

function normalizeThreadRow(row) {
  return {
    id: normalizeIdentifier(row.id),
    cwd: normalizeWorkspacePath(row.cwd),
    title: summarizeThreadTitle(row.title, row.first_user_message),
    updatedAt: Number(row.updated_at || 0),
    sourceKind: 'desktop',
    archived: !!row.archived,
    rolloutPath: normalizeFilePath(row.rollout_path),
  };
}

function summarizeThreadTitle(title, firstUserMessage) {
  const titleCandidate = firstMeaningfulLine(title);
  if (titleCandidate) {
    return truncateText(titleCandidate, 80);
  }

  const fallback = firstMeaningfulLine(firstUserMessage);
  return truncateText(fallback, 80);
}

function firstMeaningfulLine(value) {
  const lines = String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines[0] || '';
}

function normalizeFilePath(value) {
  return typeof value === 'string' && value.trim() ? value.trim().replace(/^\\\\\?\\/, '') : '';
}

function normalizeIdentifier(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function normalizeMessageText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function truncateText(value, maxLength) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function dedupeConversationMessages(messages) {
  const deduped = [];
  for (const entry of messages) {
    const previous = deduped[deduped.length - 1];
    if (previous && previous.role === entry.role && previous.text === entry.text) {
      continue;
    }
    deduped.push(entry);
  }
  return deduped;
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

function createRolloutWatcher(rolloutPath, { expectedUserText, onProgress } = {}) {
  let seenLength = 0;
  let carry = '';
  let sawExpectedUserMessage = false;
  let lastAssistantMessage = '';
  let lastProgressMessage = '';

  return {
    async waitForCompletion(timeoutMs) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        const completion = await pollRolloutFile();
        if (completion) {
          return completion;
        }
        await delay(POLL_INTERVAL_MS);
      }

      throw new Error('Timed out while waiting for Codex Desktop to finish the thread turn');
    },
  };

  async function pollRolloutFile() {
    let content = '';
    try {
      content = await fsp.readFile(rolloutPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return null;
      }
      throw error;
    }

    if (content.length < seenLength) {
      seenLength = 0;
      carry = '';
      sawExpectedUserMessage = false;
      lastAssistantMessage = '';
    }

    const delta = content.slice(seenLength);
    if (!delta) {
      return null;
    }

    seenLength = content.length;
    const chunk = `${carry}${delta}`;
    const lines = chunk.split(/\r?\n/);
    carry = lines.pop() || '';

    for (const line of lines) {
      const parsed = safeParseJson(line);
      if (!parsed || parsed.type !== 'event_msg') {
        continue;
      }

      if (parsed.payload?.type === 'user_message') {
        const userMessage = normalizeMessageText(parsed.payload.message);
        if (!expectedUserText || userMessage === expectedUserText) {
          sawExpectedUserMessage = true;
        }
      }

      if (parsed.payload?.type === 'agent_message') {
        const assistantMessage = normalizeMessageText(parsed.payload.message);
        if (assistantMessage) {
          lastAssistantMessage = assistantMessage;
          if (sawExpectedUserMessage && assistantMessage !== lastProgressMessage) {
            lastProgressMessage = assistantMessage;
            if (typeof onProgress === 'function') {
              await onProgress({
                text: assistantMessage,
                threadId: null,
              });
            }
          }
        }
      }

      if (parsed.payload?.type === 'task_complete' && (sawExpectedUserMessage || !expectedUserText)) {
        return {
          replyText: normalizeMessageText(parsed.payload.last_agent_message) || lastAssistantMessage,
        };
      }
    }

    return null;
  }
}

async function launchDesktopNewThread({ cwd, desktopAppPath }) {
  const executable = desktopAppPath || resolveDesktopAppPath();
  if (!executable) {
    throw new Error('Unable to locate the Codex Desktop launcher executable');
  }

  if (!fs.existsSync(executable)) {
    throw new Error(`Codex Desktop launcher does not exist: ${executable}`);
  }

  const child = spawn(executable, ['--open-project', cwd], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

function resolveDesktopAppPath() {
  const windowsAppsRoot = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'WindowsApps');
  let entries = [];

  try {
    entries = fs.readdirSync(windowsAppsRoot, { withFileTypes: true });
  } catch {
    return '';
  }

  const candidates = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('OpenAI.Codex_'))
    .map((entry) => ({
      name: entry.name,
      executable: path.join(windowsAppsRoot, entry.name, 'app', 'Codex.exe'),
    }))
    .filter((entry) => fs.existsSync(entry.executable))
    .sort((left, right) => right.name.localeCompare(left.name));

  return candidates[0]?.executable || '';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  DesktopCodexClient,
};
