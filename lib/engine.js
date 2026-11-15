'use strict';

// Client for the installed ModelBrain app.
//
// This file holds no ModelBrain code. It starts the app's own `mcp_server`
// program as a child process and speaks MCP to it over stdio, one JSON
// message per line, exactly as any assistant does. Everything this package
// knows about ModelBrain comes back through that public tool surface.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DOWNLOAD_URL = 'https://modelbrain.net/get-it.html';
const CLIENT_NAME = 'ModelBrain RAG';
const PROTOCOL_VERSION = '2025-06-18';
const MAX_LINE_CHARS = 64 * 1024 * 1024;
const MAX_PENDING = 64;

class EngineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}

function candidatesForPlatform(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'darwin') {
    return [
      '/Applications/ModelBrain.app/Contents/MacOS/mcp_server',
      path.join(home, 'Applications/ModelBrain.app/Contents/MacOS/mcp_server'),
    ];
  }
  if (platform === 'linux') return [path.join(home, '.local', 'lib', 'modelbrain', 'mcp_server')];
  if (platform === 'win32') {
    return env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, 'Programs', 'ModelBrain', 'mcp_server.exe')] : [];
  }
  return [];
}

// Where ModelBrain's own MCP program is. MODELBRAIN_RAG_MCP_SERVER overrides
// the search for installs in an unusual place.
function findServerBinary(env = process.env) {
  const override = env.MODELBRAIN_RAG_MCP_SERVER;
  const candidates = override ? [override] : candidatesForPlatform(process.platform, env);
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not there, or not executable. Try the next one.
    }
  }
  return null;
}

class Engine {
  // `command` and `args` start the MCP program. Tests pass a stub here.
  constructor({ command, args = [], clientVersion = '0', callTimeoutMs = 60000, startTimeoutMs = 20000 } = {}) {
    this.command = command;
    this.args = args;
    this.clientVersion = clientVersion;
    this.callTimeoutMs = callTimeoutMs;
    this.startTimeoutMs = startTimeoutMs;
    this.child = null;
    this.starting = null;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.serverInfo = null;
    this.lastStartFailure = 0;
  }

  installed() {
    return Boolean(this.command);
  }

  async ensureStarted() {
    if (this.child && this.serverInfo) return;
    if (!this.command) {
      throw new EngineError(
        'modelbrain_not_installed',
        `ModelBrain is not installed on this computer. Install it, then try again: ${DOWNLOAD_URL}`
      );
    }
    if (this.starting) return this.starting;
    // After a failed start, wait a moment before trying again so a broken
    // install is not started in a tight loop.
    if (Date.now() - this.lastStartFailure < 2000) {
      throw new EngineError('modelbrain_unavailable', 'ModelBrain did not start. Trying again shortly.');
    }
    this.starting = this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async start() {
    let child;
    try {
      child = spawn(this.command, this.args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    } catch (err) {
      this.lastStartFailure = Date.now();
      throw new EngineError('modelbrain_unavailable', `Could not start ModelBrain's MCP program: ${err.message}`);
    }
    this.child = child;
    this.buffer = '';
    this.serverInfo = null;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.onData(child, chunk));
    child.stdin.on('error', () => {});
    const gone = (reason) => this.onGone(child, reason);
    child.on('error', (err) => gone(err.message));
    child.on('exit', () => gone('ModelBrain closed the connection.'));

    try {
      const result = await this.request(
        'initialize',
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: CLIENT_NAME, version: this.clientVersion },
        },
        this.startTimeoutMs
      );
      this.serverInfo = (result && result.serverInfo) || {};
      this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    } catch (err) {
      this.lastStartFailure = Date.now();
      this.stop();
      throw err instanceof EngineError
        ? err
        : new EngineError('modelbrain_unavailable', `ModelBrain did not answer: ${err.message}`);
    }
  }

  onData(child, chunk) {
    if (child !== this.child) return;
    this.buffer += chunk;
    // A reply is one line. A line this long means something is wrong with
    // the program on the other end, so stop it and start again next call.
    if (this.buffer.length > MAX_LINE_CHARS && this.buffer.indexOf('\n') === -1) {
      this.stop();
      return;
    }
    let nl;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg === null || typeof msg !== 'object' || msg.id === undefined || msg.id === null) continue;
      const waiter = this.pending.get(msg.id);
      if (!waiter) continue;
      this.pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.error) {
        const code = (msg.error.data && typeof msg.error.data.code === 'string' && msg.error.data.code) || 'modelbrain_error';
        waiter.reject(new EngineError(code, String(msg.error.message || 'ModelBrain returned an error.')));
      } else {
        waiter.resolve(msg.result);
      }
    }
  }

  onGone(child, reason) {
    if (child !== this.child) return;
    this.child = null;
    this.serverInfo = null;
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new EngineError('modelbrain_unavailable', reason));
    }
    this.pending.clear();
  }

  send(obj) {
    if (!this.child) throw new EngineError('modelbrain_unavailable', 'ModelBrain is not running.');
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (this.pending.size >= MAX_PENDING) {
        reject(new EngineError('modelbrain_busy', 'Too many requests are waiting for ModelBrain. Try again in a moment.'));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new EngineError('modelbrain_timeout', `ModelBrain did not answer within ${Math.round(timeoutMs / 1000)} s.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  // Calls one ModelBrain tool and returns its structured result.
  async call(name, args = {}, timeoutMs = this.callTimeoutMs) {
    await this.ensureStarted();
    const result = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    return parseToolResult(result);
  }

  version() {
    return (this.serverInfo && this.serverInfo.version) || null;
  }

  stop() {
    const child = this.child;
    this.onGone(child, 'Stopped.');
    if (child) {
      try {
        child.stdin.end();
      } catch {
        // Already closed.
      }
      child.kill();
    }
  }
}

function parseToolResult(result) {
  if (result === null || typeof result !== 'object') {
    throw new EngineError('modelbrain_error', 'ModelBrain returned an empty result.');
  }
  const text = Array.isArray(result.content)
    ? result.content
        .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n')
    : '';
  if (result.isError) {
    throw new EngineError('modelbrain_tool_error', text || 'ModelBrain refused the request.');
  }
  if (result.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // Not JSON. Fall through.
  }
  return { text };
}

module.exports = { Engine, EngineError, findServerBinary, candidatesForPlatform, parseToolResult, DOWNLOAD_URL, CLIENT_NAME };
