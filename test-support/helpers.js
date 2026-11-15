'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Documents } = require('../lib/documents.js');
const { Engine } = require('../lib/engine.js');
const { KeyStore } = require('../lib/keys.js');
const { UserStore } = require('../lib/users.js');
const { createApp } = require('../lib/server.js');

const STUB = path.join(__dirname, 'stub-mcp-server.js');

// Starts the server on a free port with temp folders and a stub ModelBrain.
// `stubEnv` sets the stub's behaviour; `connected: false` makes the stub
// report no folder connection; `installed: false` gives the engine nothing
// to start.
async function startServer({ stubEnv = {}, connected = true, installed = true, allowOrigins = [], maxUploadBytes = 1024 * 1024, docsSubdir = '' } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mbrag-')));
  const connectorRoot = path.join(base, 'vault');
  const docsDir = path.join(connectorRoot, docsSubdir);
  fs.mkdirSync(docsDir, { recursive: true });
  const log = path.join(base, 'stub.log');
  const saved = {};
  const env = { STUB_ROOT: connected ? connectorRoot : '', STUB_LOG: log, STUB_MODE: '', STUB_HITS: '', ...stubEnv };
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const documents = new Documents(docsDir);
  const keys = new KeyStore(path.join(base, 'config', 'keys.json'));
  const admin = keys.create({ name: 'admin', access: 'admin' }).key;
  const users = new UserStore(path.join(base, 'config', 'users.json'));
  await users.create({ username: 'admin', password: 'admin-password-1', access: 'admin' });
  const engine = new Engine(installed ? { command: process.execPath, args: [STUB], clientVersion: 'test', callTimeoutMs: 5000 } : {});
  const server = createApp({ engine, documents, keys, users, config: { port: 0, allowOrigins, maxUploadBytes, dir: path.join(base, 'config'), shared: { vaults: [], partitions: [] } }, version: 'test' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;
  const call = async (method, route, { key = admin, body, raw, headers = {} } = {}) => {
    const init = { method, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...headers } };
    if (raw !== undefined) init.body = raw;
    else if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(url + route, init);
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
  };
  const stubCalls = () =>
    fs.existsSync(log)
      ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
  const close = async () => {
    engine.stop();
    await new Promise((resolve) => {
      server.close(resolve);
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(base, { recursive: true, force: true });
  };
    const login = async (username, password) => (await call('POST', '/v1/login', { key: null, body: { username, password } }));
  return { base, docsDir, connectorRoot, documents, keys, users, admin, engine, server, port, url, call, login, stubCalls, close };
}

module.exports = { startServer, STUB };
