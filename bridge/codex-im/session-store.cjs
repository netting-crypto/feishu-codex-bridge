const fs = require('fs');
const path = require('path');

class SessionStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = createEmptyState();
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        this.state = {
          ...createEmptyState(),
          ...parsed,
          bindings: parsed.bindings || {},
        };
      }
    } catch {
      this.state = createEmptyState();
    }
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  buildBindingKey({ workspaceId, chatId, threadKey, senderId, messageId }) {
    const normalizedThreadKey = normalizeValue(threadKey);
    const normalizedMessageId = normalizeValue(messageId);
    const hasStableThreadKey = normalizedThreadKey && normalizedThreadKey !== normalizedMessageId;

    if (hasStableThreadKey) {
      return `${workspaceId}:${chatId}:thread:${normalizedThreadKey}`;
    }

    return `${workspaceId}:${chatId}:sender:${senderId}`;
  }

  getBinding(bindingKey) {
    return this.state.bindings[bindingKey] || null;
  }

  updateBinding(bindingKey, nextBinding) {
    this.state.bindings[bindingKey] = {
      ...nextBinding,
      updatedAt: new Date().toISOString(),
    };
    this.save();
    return this.state.bindings[bindingKey];
  }

  getActiveWorkspaceRoot(bindingKey) {
    return this.state.bindings[bindingKey]?.activeWorkspaceRoot || '';
  }

  setActiveWorkspaceRoot(bindingKey, workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    const current = this.getBinding(bindingKey) || { threadIdByWorkspaceRoot: {} };
    const threadIdByWorkspaceRoot = { ...(current.threadIdByWorkspaceRoot || {}) };
    if (normalizedWorkspaceRoot && !(normalizedWorkspaceRoot in threadIdByWorkspaceRoot)) {
      threadIdByWorkspaceRoot[normalizedWorkspaceRoot] = '';
    }

    return this.updateBinding(bindingKey, {
      ...current,
      activeWorkspaceRoot: normalizedWorkspaceRoot,
      threadIdByWorkspaceRoot,
    });
  }

  getThreadIdForWorkspace(bindingKey, workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return '';
    }
    return this.state.bindings[bindingKey]?.threadIdByWorkspaceRoot?.[normalizedWorkspaceRoot] || '';
  }

  setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId, extra = {}) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return this.getBinding(bindingKey);
    }

    const current = this.getBinding(bindingKey) || {};
    const threadIdByWorkspaceRoot = {
      ...(current.threadIdByWorkspaceRoot || {}),
      [normalizedWorkspaceRoot]: normalizeValue(threadId),
    };

    return this.updateBinding(bindingKey, {
      ...current,
      ...extra,
      activeWorkspaceRoot: normalizedWorkspaceRoot,
      threadIdByWorkspaceRoot,
    });
  }

  clearThreadIdForWorkspace(bindingKey, workspaceRoot) {
    return this.setThreadIdForWorkspace(bindingKey, workspaceRoot, '');
  }

  listBoundWorkspaces(bindingKey) {
    const binding = this.getBinding(bindingKey) || {};
    const activeWorkspaceRoot = normalizeValue(binding.activeWorkspaceRoot);
    return Object.entries(binding.threadIdByWorkspaceRoot || {})
      .map(([workspaceRoot, threadId]) => ({
        workspaceRoot,
        threadId: normalizeValue(threadId),
        isActive: workspaceRoot === activeWorkspaceRoot,
      }))
      .sort((left, right) => left.workspaceRoot.localeCompare(right.workspaceRoot));
  }
}

function createEmptyState() {
  return {
    bindings: {},
  };
}

function normalizeValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

module.exports = { SessionStore };
