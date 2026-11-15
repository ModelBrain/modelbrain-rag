'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { startServer } = require('../test-support/helpers.js');
const config = require('../lib/config.js');
const { Documents } = require('../lib/documents.js');
const { KeyStore } = require('../lib/keys.js');
const { splitSource } = require('../lib/server.js');

test('the web page is served with a policy that allows only its own files', async () => {
  const s = await startServer();
  try {
    for (const [route, type] of [['/', 'text/html'], ['/ui/app.js', 'text/javascript'], ['/ui/app.css', 'text/css'], ['/ui/favicon.svg', 'image/svg+xml']]) {
      const res = await fetch(s.url + route);
      assert.equal(res.status, 200, route);
      assert.ok(res.headers.get('content-type').startsWith(type), route);
      const csp = res.headers.get('content-security-policy');
      assert.match(csp, /default-src 'none'/);
      assert.match(csp, /script-src 'self'/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.ok(!csp.includes('unsafe'));
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
      await res.text();
    }
    assert.equal((await fetch(`${s.url}/ui/../lib/keys.js`)).status, 404);
    assert.equal((await fetch(`${s.url}/ui/app.js.map`)).status, 404);
  } finally {
    await s.close();
  }
});

test('the page holds no inline script or style and never builds HTML from data', () => {
  const dir = path.join(__dirname, '..', 'lib', 'ui');
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), 'inline script');
  assert.ok(!/<style/.test(html) && !/\sstyle=/.test(html) && !/\son[a-z]+=/.test(html), 'inline style or handler');
  assert.ok(!/https?:\/\//.test(html), 'outside address in the page');
  const js = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
  for (const banned of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'localStorage']) {
    assert.ok(!js.includes(banned), banned);
  }
  const css = fs.readFileSync(path.join(dir, 'app.css'), 'utf8');
  assert.ok(!/url\(/.test(css) && !/@import/.test(css), 'outside resource in the styles');
});

test('requests from the page itself are accepted; other pages still are not', async () => {
  const s = await startServer();
  try {
    for (const origin of [`http://127.0.0.1:${s.port}`, `http://localhost:${s.port}`]) {
      const res = await s.call('POST', '/v1/search', { body: { query: 'a' }, headers: { Origin: origin } });
      assert.equal(res.status, 200, origin);
      assert.equal(res.headers.get('access-control-allow-origin'), null);
    }
    for (const origin of [`http://127.0.0.1:${s.port + 1}`, `https://127.0.0.1:${s.port}`, 'null', `http://127.0.0.1:${s.port}.evil.example`]) {
      assert.equal((await s.call('POST', '/v1/search', { body: { query: 'a' }, headers: { Origin: origin } })).status, 403, origin);
    }
  } finally {
    await s.close();
  }
});

test('an admin changes the port for the next start; others cannot', async () => {
  const s = await startServer();
  try {
    const before = await s.call('GET', '/v1/settings');
    assert.equal(before.json.listening_port, s.port);
    const saved = await s.call('PUT', '/v1/settings', { body: { port: 9123 } });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.port, 9123);
    assert.equal(saved.json.restart_required, true);
    assert.equal(config.loadSettings(path.join(s.base, 'config')).port, 9123);
    for (const port of [0, 80, 70000, 'abc', 1.5, null, true, [8080], '0x50', '8e3', ' 9000']) {
      assert.equal((await s.call('PUT', '/v1/settings', { body: { port } })).status, 400, String(port));
    }
    const writer = (await s.call('POST', '/v1/keys', { body: { name: 'w', access: 'write' } })).json.key;
    assert.equal((await s.call('GET', '/v1/settings', { key: writer })).status, 403);
    assert.equal((await s.call('PUT', '/v1/settings', { key: writer, body: { port: 9124 } })).status, 403);
    // The server keeps answering on the port it started with.
    assert.equal((await s.call('GET', '/health', { key: null })).status, 200);
  } finally {
    await s.close();
  }
});

test('a key revoked by another process stops working even within the same clock tick', async () => {
  const s = await startServer();
  try {
    const file = path.join(s.base, 'config', 'keys.json');
    const made = (await s.call('POST', '/v1/keys', { body: { name: 'app', access: 'read' } })).json;
    assert.equal((await s.call('GET', '/v1/me', { key: made.key })).status, 200);
    const stamp = fs.statSync(file);
    new KeyStore(file).revoke(made.id);
    fs.utimesSync(file, stamp.atime, stamp.mtime);
    assert.equal((await s.call('GET', '/v1/me', { key: made.key })).status, 401);
    // Writing last-used times must not bring the key back.
    s.keys.flush();
    assert.ok(new KeyStore(file).list().find((k) => k.id === made.id).revoked);
  } finally {
    await s.close();
  }
});

test('a damaged key file does not take the server down or lock everyone out', async () => {
  const s = await startServer();
  try {
    const file = path.join(s.base, 'config', 'keys.json');
    fs.writeFileSync(file, '{ not json');
    assert.equal((await s.call('GET', '/v1/me')).status, 200);
    assert.equal((await s.call('GET', '/health', { key: null })).status, 200);
    assert.throws(() => new KeyStore(file), /damaged/);
  } finally {
    await s.close();
  }
});

test('hand-made folders with awkward names do not break listing, and skipped names are refused', async () => {
  const s = await startServer();
  try {
    fs.mkdirSync(path.join(s.docsDir, 'good'));
    fs.mkdirSync(path.join(s.docsDir, 'Old notes.'));
    fs.mkdirSync(path.join(s.docsDir, 'logs'));
    const cols = await s.call('GET', '/v1/collections');
    assert.equal(cols.status, 200);
    assert.deepEqual(cols.json.collections.map((c) => c.name), ['good']);
    assert.deepEqual(cols.json.skipped, ['logs', 'Old notes.']);

    for (const name of ['tmp', 'Build', 'node_modules', 'Claude outputs']) {
      const res = await s.call('POST', '/v1/collections', { body: { name } });
      assert.equal(res.status, 422, name);
      assert.equal(res.json.error.code, 'name_not_indexed');
    }
    assert.equal((await s.call('PUT', '/v1/collections/good/documents/package-lock.json', { raw: '{}' })).status, 422);
    // Ordinary documents with these words in the name are indexed by ModelBrain, so they are accepted.
    for (const name of ['secret-santa.md', 'Credentials.txt', 'Package-Lock.json']) {
      assert.equal((await s.call('PUT', `/v1/collections/good/documents/${name}`, { raw: 'x' })).status, 201, name);
    }
    // A hand-made folder ModelBrain skips does not take uploads either.
    assert.equal((await s.call('PUT', '/v1/collections/logs/documents/a.md', { raw: 'x' })).status, 422);
    for (const name of ['a\u202egpj.exe.md', 'zero\u200bwidth.md', 'line\u2028sep.md']) {
      assert.equal((await s.call('PUT', `/v1/collections/good/documents/${encodeURIComponent(name)}`, { raw: 'x' })).status, 400, 'invisible character');
    }
    assert.equal((await s.call('POST', '/v1/collections', { body: { name: 'GOOD' } })).status, process.platform === 'linux' ? 409 : 200);
    for (const name of ['CONIN$', 'com0.md', 'con .md', 'COM¹.md', ' lead.md']) {
      assert.equal((await s.call('PUT', `/v1/collections/good/documents/${encodeURIComponent(name)}`, { raw: 'x' })).status, 400, name);
    }
  } finally {
    await s.close();
  }
});

test('a planted temp folder link is refused and nothing is written through it', { skip: process.platform === 'win32' }, async () => {
  const s = await startServer();
  try {
    const outside = path.join(s.base, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(s.docsDir, '.modelbrain-rag-tmp'));
    const res = await s.call('PUT', '/v1/collections/handbook/documents/a.md', { raw: 'x' });
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, 'temp_folder_blocked');
    assert.deepEqual(fs.readdirSync(outside), []);
    const docs = new Documents(s.docsDir);
    assert.equal(docs.stillInside(path.join(s.docsDir, 'handbook'), 'handbook'), true);
    assert.equal(docs.stillInside(path.join(s.docsDir, '.modelbrain-rag-tmp'), '.modelbrain-rag-tmp'), false);
  } finally {
    await s.close();
  }
});

test('settings are checked: upload limit and web origins', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mbrag-set-'));
  try {
    const env = { MODELBRAIN_RAG_CONFIG_DIR: dir };
    config.saveSettings(dir, { maxUploadBytes: '32MB' });
    assert.throws(() => config.resolve({ env }), /maxUploadBytes/);
    config.saveSettings(dir, { allowOrigins: 'http://localhost:3000' });
    assert.throws(() => config.resolve({ env }), /origins/);
    config.saveSettings(dir, { allowOrigins: ['http://localhost:3000/', 'HTTP://Example.com:80/path'] });
    assert.deepEqual(config.resolve({ env }).allowOrigins, ['http://localhost:3000', 'http://example.com']);
    config.saveSettings(dir, { allowOrigins: ['not a url'] });
    assert.throws(() => config.resolve({ env }), /not a web origin/);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(dir, 'settings.json')).mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hits are split into collection and document by folder level, whatever the letters', () => {
  assert.deepEqual(splitSource('RAG Docs/handbook/refunds.md', ['RAG Docs']), { collection: 'handbook', document: 'refunds.md' });
  assert.deepEqual(splitSource('rag docs/handbook/sub/deep.md', ['RAG Docs']), { collection: 'handbook', document: 'sub/deep.md' });
  assert.deepEqual(splitSource('handbook/refunds.md', []), { collection: 'handbook', document: 'refunds.md' });
  assert.deepEqual(splitSource('loose.md', []), { collection: null, document: 'loose.md' });
  assert.deepEqual(splitSource('RAG Docs/loose.md', ['RAG Docs']), { collection: null, document: 'loose.md' });
  assert.deepEqual(splitSource('İstanbul/handbook/a.md', ['İstanbul']), { collection: 'handbook', document: 'a.md' });
  assert.deepEqual(splitSource('', []), { collection: null, document: '' });
});

test('odd requests get a plain refusal, not a crash', async () => {
  const s = await startServer({ stubEnv: { STUB_HITS: JSON.stringify([null, 5, { text: 'ok', connector_id: 'docs', source_uri: 'c/d.md' }]) } });
  try {
    const net = require('node:net');
    const raw = await new Promise((resolve) => {
      const socket = net.connect(s.port, '127.0.0.1', () => {
        socket.write(`GET http://[::1 HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nConnection: close\r\n\r\n`);
      });
      let data = '';
      socket.on('data', (chunk) => { data += chunk; });
      socket.on('close', () => resolve(data));
    });
    assert.match(raw, /^HTTP\/1\.1 400/);
    const res = await s.call('POST', '/v1/search', { body: { query: 'a' } });
    assert.equal(res.status, 200);
    assert.equal(res.json.count, 1);
    assert.equal(res.json.results[0].document, 'd.md');
    assert.equal((await s.call('GET', '/health', { key: null })).status, 200);
  } finally {
    await s.close();
  }
});
