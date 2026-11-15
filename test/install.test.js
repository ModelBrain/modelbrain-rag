'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Documents } = require('../lib/documents.js');
const { Engine } = require('../lib/engine.js');
const { KeyStore } = require('../lib/keys.js');
const { createApp } = require('../lib/server.js');
const http = require('node:http');
const { Setup, readCode, idForCode } = require('../lib/setup.js');
const service = require('../lib/service.js');
const { UserStore } = require('../lib/users.js');

async function freshServer() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mbrag-setup-'));
  const dir = path.join(base, 'config');
  fs.mkdirSync(path.join(base, 'docs'));
  const users = new UserStore(path.join(dir, 'users.json'));
  const setup = new Setup(dir);
  setup.begin();
  const server = createApp({ engine: new Engine({}), documents: new Documents(path.join(base, 'docs')), keys: new KeyStore(path.join(dir, 'keys.json')), users, config: { port: 0, allowOrigins: [], maxUploadBytes: 1024, dir, shared: { vaults: [], partitions: [] } }, version: 'test', setup });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = async (route, body, token) => {
    const res = await fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  const close = async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(base, { recursive: true, force: true });
  };
  return { url, dir, post, close, users, setup };
}

test('first run from an installer: the one-time code makes the first admin, once', async () => {
  const s = await freshServer();
  try {
    const code = readCode(s.dir);
    const health = await (await fetch(`${s.url}/health`)).json();
    assert.equal(health.needs_setup, true);
    assert.equal(health.setup_id, idForCode(code));
    assert.equal(JSON.stringify(health).includes(code), false);
    assert.match(code, /^[A-Za-z0-9_-]{43}$/);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(s.dir, 'setup-code')).mode & 0o777, 0o600);

    const account = { username: 'matt', password: 'a-good-password' };
    assert.equal((await s.post('/v1/setup', { ...account })).status, 403);
    assert.equal((await s.post('/v1/setup', { ...account, code: 'x'.repeat(43) })).status, 403);
    assert.equal((await s.post('/v1/setup', { ...account, code: [code] })).status, 403);
    // A weak password is refused and the code stays good.
    assert.equal((await s.post('/v1/setup', { username: 'matt', password: 'short', code })).status, 400);
    assert.equal(s.users.list().length, 0);

    const made = await s.post('/v1/setup', { ...account, code });
    assert.equal(made.status, 201);
    assert.equal(made.json.signed_in.access, 'admin');
    const me = await fetch(`${s.url}/v1/me`, { headers: { Authorization: `Bearer ${made.json.token}` } });
    assert.equal(me.status, 200);

    assert.equal(readCode(s.dir), null);
    assert.equal((await (await fetch(`${s.url}/health`)).json()).needs_setup, false);
    assert.equal((await s.post('/v1/setup', { username: 'eve', password: 'another-password', code })).status, 404);
    assert.equal(s.users.list().length, 1);
  } finally {
    await s.close();
  }
});

test('too many wrong setup codes replace the code; setup is never lost', async () => {
  const s = await freshServer();
  try {
    const old = readCode(s.dir);
    // A request with no code at all is refused but is not a guess.
    for (let i = 0; i < 30; i += 1) assert.equal((await s.post('/v1/setup', { username: 'a', password: 'b' })).status, 403);
    assert.equal(readCode(s.dir), old);
    for (let i = 0; i < 20; i += 1) assert.equal((await s.post('/v1/setup', { username: 'a', password: 'b', code: 'y'.repeat(43) })).status, 403);
    const fresh = readCode(s.dir);
    assert.ok(fresh && fresh !== old);
    assert.equal((await s.post('/v1/setup', { username: 'matt', password: 'a-good-password', code: old })).status, 403);
    assert.equal((await (await fetch(`${s.url}/health`)).json()).needs_setup, true);
    assert.equal((await s.post('/v1/setup', { username: 'matt', password: 'a-good-password', code: fresh })).status, 201);
  } finally {
    await s.close();
  }
});

test('the setup code works once even when several requests arrive together', async () => {
  const s = await freshServer();
  try {
    const code = readCode(s.dir);
    const all = await Promise.all(['ann', 'bob', 'cat'].map((username) => s.post('/v1/setup', { username, password: 'a-good-password', code })));
    assert.deepEqual(all.map((r) => r.status).sort(), [201, 404, 404]);
    assert.equal(s.users.list().length, 1);
  } finally {
    await s.close();
  }
});

test('a web page on another site can neither use nor wear out the setup code', async () => {
  const s = await freshServer();
  try {
    const code = readCode(s.dir);
    for (let i = 0; i < 25; i += 1) {
      const res = await fetch(`${s.url}/v1/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ username: 'eve', password: 'another-password', code: i === 0 ? code : 'z'.repeat(43) }) });
      assert.equal(res.status, 403);
    }
    assert.equal(readCode(s.dir), code);
    assert.equal(s.users.list().length, 0);
    assert.equal((await s.post('/v1/setup', { username: 'matt', password: 'a-good-password', code })).status, 201);
  } finally {
    await s.close();
  }
});

test('an admin made on the command line ends setup for good', async () => {
  const s = await freshServer();
  try {
    const code = readCode(s.dir);
    await s.users.create({ username: 'cli', password: 'cli-password-1', access: 'admin' });
    assert.equal((await (await fetch(`${s.url}/health`)).json()).needs_setup, false);
    assert.equal(readCode(s.dir), null);
    assert.equal((await s.post('/v1/setup', { username: 'eve', password: 'another-password', code })).status, 404);
  } finally {
    await s.close();
  }
});

test('a server with an admin already never offers setup', async () => {
  const s = await freshServer();
  try {
    await s.users.create({ username: 'admin', password: 'admin-password-1', access: 'admin' });
    assert.equal((await (await fetch(`${s.url}/health`)).json()).needs_setup, false);
    assert.equal((await s.post('/v1/setup', { username: 'eve', password: 'another-password', code: readCode(s.dir) })).status, 404);
  } finally {
    await s.close();
  }
});

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'modelbrain-rag.js'), ...args], { env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => resolve({ code, out }));
  });
}

async function freePort() {
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
}

async function waitHealth(port) {
  for (let i = 0; i < 60; i += 1) {
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json(), () => null);
    if (health) return health;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

test('as a service: no password printed, a second copy cannot replace the code, open sends it only to the real server, stop removes it', { skip: process.platform === 'win32' }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mbrag-svc-'));
  const port = await freePort();
  const cfg = path.join(base, 'cfg');
  // A stand-in for the browser opener that records what it was asked to open.
  const fake = path.join(base, 'bin');
  fs.mkdirSync(fake);
  const opened = path.join(base, 'opened.txt');
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  fs.writeFileSync(path.join(fake, opener), `#!/bin/sh\nprintf '%s' "$1" > '${opened}'\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${fake}:${process.env.PATH}`, MODELBRAIN_RAG_CONFIG_DIR: cfg, MODELBRAIN_RAG_DIR: path.join(base, 'docs'), MODELBRAIN_RAG_PORT: String(port), MODELBRAIN_RAG_MCP_SERVER: path.join(base, 'none') };
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'modelbrain-rag.js'), 'start', '--service'], { env });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((r) => child.on('exit', r));
  try {
    const health = await waitHealth(port);
    assert.equal(health.needs_setup, true);
    assert.doesNotMatch(out, /Password|mbrag_/);
    const code = readCode(cfg);
    assert.ok(code);
    assert.equal(fs.existsSync(path.join(cfg, 'keys.json')), false);

    // A second copy cannot bind the port, and must leave the code alone.
    const second = await runCli(['start', '--service'], env);
    assert.equal(second.code, 1);
    assert.match(second.out, /already in use/);
    assert.equal(readCode(cfg), code);

    // open hands the browser a private file, not an address with the code.
    const ok = await runCli(['open'], env);
    assert.equal(ok.code, 0, ok.out);
    for (let i = 0; i < 30 && !fs.existsSync(opened); i += 1) await new Promise((r) => setTimeout(r, 100));
    const target = fs.readFileSync(opened, 'utf8');
    assert.equal(target.includes(code), false);
    assert.match(path.basename(target), /^open-setup-[0-9a-f]{12}\.html$/);
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.ok(fs.readFileSync(target, 'utf8').includes(`http://127.0.0.1:${port}/#setup=${code}`));

    child.kill();
    await exited;
    assert.equal(readCode(cfg), null);
    assert.equal(fs.existsSync(target), false);

    // Something else answering on the port does not get the code.
    fs.mkdirSync(cfg, { recursive: true });
    fs.writeFileSync(path.join(cfg, 'setup-code'), `${code}\n`, { mode: 0o600 });
    fs.rmSync(opened, { force: true });
    const fakeServer = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, name: 'modelbrain-rag', version: '0.1.0', needs_setup: true, setup_id: '0'.repeat(32) }));
    });
    await new Promise((r) => fakeServer.listen(port, '127.0.0.1', r));
    try {
      const refused = await runCli(['open'], env);
      assert.equal(refused.code, 1);
      assert.match(refused.out, /was not sent/);
      assert.equal(fs.existsSync(opened), false);
      assert.equal(fs.readdirSync(cfg).some((n) => n.startsWith('open-setup-')), false);
    } finally {
      fakeServer.closeAllConnections();
      await new Promise((r) => fakeServer.close(r));
    }
  } finally {
    child.kill();
    await exited;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('start-at-sign-in entries are well formed', () => {
  const plist = service.launchAgentPlist({ node: '/Library/Application Support/ModelBrain RAG/node', script: '/x/R&D <app>/bin/modelbrain-rag.js', logFile: '/Users/a/Library/Application Support/ModelBrain RAG/server.log' });
  assert.match(plist, /<string>net\.modelbrain\.rag<\/string>/);
  assert.match(plist, /<string>\/x\/R&amp;D &lt;app&gt;\/bin\/modelbrain-rag\.js<\/string>\n    <string>start<\/string>\n    <string>--service<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\n  <true\/>/);
  const unit = service.systemdUnit({ node: '/usr/bin/node', script: '/home/a b/100%/bin/modelbrain-rag.js' });
  assert.match(unit, /ExecStart="\/usr\/bin\/node" "\/home\/a b\/100%%\/bin\/modelbrain-rag\.js" start --service/);
  // Settings in force at install time travel with the service.
  const env = service.settingsEnv({ MODELBRAIN_RAG_PORT: '9000', MODELBRAIN_RAG_DIR: '/d/My "Docs" $x', OTHER: 'no', MODELBRAIN_RAG_EMPTY: '' });
  assert.deepEqual(env, { MODELBRAIN_RAG_PORT: '9000', MODELBRAIN_RAG_DIR: '/d/My "Docs" $x' });
  const withEnv = service.launchAgentPlist({ node: '/n', script: '/s', logFile: '/l', env });
  assert.match(withEnv, /<key>EnvironmentVariables<\/key>\n  <dict>\n    <key>MODELBRAIN_RAG_PORT<\/key>\n    <string>9000<\/string>/);
  assert.equal(plist.includes('EnvironmentVariables'), false);
  assert.ok(service.systemdUnit({ node: '/n', script: '/s', env }).includes('Environment="MODELBRAIN_RAG_DIR=/d/My \\"Docs\\" $$x"\n'));
  assert.equal(service.paths('darwin', '/Users/a').file, '/Users/a/Library/LaunchAgents/net.modelbrain.rag.plist');
  assert.equal(service.paths('win32', 'C:\\Users\\a'), null);
  assert.throws(() => service.install({ script: 'x', logDir: 'y', platform: 'win32' }), /installer/);
  assert.deepEqual(service.browserCommand('http://127.0.0.1:1/#setup=abc', 'darwin'), ['open', ['http://127.0.0.1:1/#setup=abc']]);
});
