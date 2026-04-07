const net = require('net');

const DEFAULT_PIPE_PATH = '\\\\.\\pipe\\codex-ipc';
const DEFAULT_REQUEST_TIMEOUT_MS = 20000;
const REQUEST_VERSIONS = {
  'thread-follower-start-turn': 1,
};

class DesktopIpcClient {
  constructor({ pipePath = DEFAULT_PIPE_PATH, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
    this.pipePath = pipePath;
    this.requestTimeoutMs = requestTimeoutMs;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.messageListeners = new Set();
    this.clientId = '';
    this.connected = false;
  }

  async connect() {
    if (this.connected && this.socket) {
      return;
    }

    await new Promise((resolve, reject) => {
      const socket = net.createConnection(this.pipePath);
      this.socket = socket;

      const cleanup = () => {
        socket.removeListener('connect', onConnect);
        socket.removeListener('error', onError);
      };

      const onConnect = () => {
        cleanup();
        this.connected = true;
        this.attachSocket(socket);
        resolve();
      };

      const onError = (error) => {
        cleanup();
        reject(error);
      };

      socket.once('connect', onConnect);
      socket.once('error', onError);
    });
  }

  async initialize(clientType = 'feishu-codex-bridge') {
    if (this.clientId) {
      return this.clientId;
    }

    const response = await this.sendRequest('initialize', {
      clientType,
    });
    this.clientId = normalizeIdentifier(response?.result?.clientId) || normalizeIdentifier(response?.handledByClientId);
    return this.clientId;
  }

  close() {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.end();
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
    this.clientId = '';
    this.buffer = Buffer.alloc(0);
    this.pending.clear();
  }

  onMessage(listener) {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  async startTurn({ conversationId, text }) {
    return this.sendRequest('thread-follower-start-turn', {
      conversationId,
      turnStartParams: {
        input: [
          {
            type: 'text',
            text,
            text_elements: [],
          },
        ],
        cwd: null,
        approvalPolicy: null,
        sandboxPolicy: null,
        model: null,
        serviceTier: null,
        effort: null,
        attachments: [],
        collaborationMode: null,
      },
    });
  }

  async sendRequest(method, params) {
    if (!this.socket || !this.connected) {
      throw new Error('Codex desktop IPC is not connected');
    }

    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const payload = {
      type: 'request',
      requestId,
      method,
      params: params || {},
    };

    const version = REQUEST_VERSIONS[method];
    if (version) {
      payload.version = version;
    }

    const responsePromise = new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Codex desktop IPC timeout: ${method}`));
      }, this.requestTimeoutMs);

      this.pending.set(requestId, {
        resolve: (value) => {
          clearTimeout(timeoutId);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
      });
    });

    this.sendRaw(payload);
    return responsePromise;
  }

  attachSocket(socket) {
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.flushBuffer();
    });

    socket.on('close', () => {
      this.connected = false;
      this.clientId = '';
      const error = new Error('Codex desktop IPC connection closed');
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
    });

    socket.on('error', (error) => {
      for (const listener of this.messageListeners) {
        listener({
          type: 'error',
          error,
        });
      }
    });
  }

  flushBuffer() {
    while (this.buffer.length >= 4) {
      const messageLength = this.buffer.readUInt32LE(0);
      if (this.buffer.length < 4 + messageLength) {
        return;
      }

      const payload = this.buffer.subarray(4, 4 + messageLength).toString('utf8');
      this.buffer = this.buffer.subarray(4 + messageLength);

      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }

      this.handleIncoming(parsed);
    }
  }

  handleIncoming(message) {
    if (message?.type === 'response' && typeof message.requestId === 'string' && this.pending.has(message.requestId)) {
      const pending = this.pending.get(message.requestId);
      this.pending.delete(message.requestId);
      if (message.resultType === 'error') {
        pending.reject(new Error(message.error || 'Codex desktop IPC request failed'));
        return;
      }
      pending.resolve(message);
      return;
    }

    for (const listener of this.messageListeners) {
      listener(message);
    }
  }

  sendRaw(payload) {
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8');
    const framed = Buffer.alloc(4 + encoded.length);
    framed.writeUInt32LE(encoded.length, 0);
    encoded.copy(framed, 4);
    this.socket.write(framed);
  }
}

function normalizeIdentifier(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

module.exports = {
  DesktopIpcClient,
};
