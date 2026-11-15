'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { startServer } = require('../test-support/helpers.js');

test('health needs no key and says nothing private', async () => {
  const s = await startServer();
  try {
    const res = await s.call('GET', '/health', { key: null });
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.json).sort(), ['name', 'needs_setup', 'ok', 'version']);
  } finally {
    await s.close();
  }
});

test('every /v1 route refuses a missing, wrong or revoked key', async () => {
  const s = await startServer();
  try {
    assert.equal((await s.call('GET', '/v1/status', { key: null })).status, 401);
    assert.equal((await s.call('GET', '/v1/status', { key: 'mbrag_abcdef_nope' })).status, 401);
    assert.equal((await s.call('POST', '/v1/search', { key: 'x', body: { query: 'a' } })).status, 401);
    const made = (await s.call('POST', '/v1/keys', { body: { name: 'temp', access: 'read' } })).json;
    assert.equal((await s.call('GET', '/v1/status', { key: made.key })).status, 200);
    assert.equal((await s.call('DELETE', `/v1/keys/${made.id}`)).status, 200);
    const after = await s.call('GET', '/v1/status', { key: made.key });
    assert.equal(after.status, 401);
    assert.equal(after.headers.get('www-authenticate'), 'Bearer');
  } finally {
    await s.close();
  }
});

test('requests for another host name or from a web page are refused', async () => {
  const s = await startServer();
  try {
    const viaHost = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: s.port, path: '/health', headers: { Host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(viaHost, 403);
    const fromPage = await s.call('GET', '/v1/status', { headers: { Origin: 'https://evil.example' } });
    assert.equal(fromPage.status, 403);
    assert.equal(fromPage.json.error.code, 'origin_not_allowed');
  } finally {
    await s.close();
  }
});

test('an allowed web origin gets CORS headers and a preflight answer', async () => {
  const s = await startServer({ allowOrigins: ['http://localhost:3000'] });
  try {
    const res = await s.call('GET', '/health', { key: null, headers: { Origin: 'http://localhost:3000' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:3000');
    const pre = await fetch(`${s.url}/v1/search`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:3000' } });
    assert.equal(pre.status, 204);
  } finally {
    await s.close();
  }
});

test('status reports ModelBrain and whether the documents folder is connected', async () => {
  const s = await startServer();
  try {
    const res = await s.call('GET', '/v1/status');
    assert.equal(res.status, 200);
    assert.equal(res.json.modelbrain.reachable, true);
    assert.equal(res.json.modelbrain.version, '0.9.4');
    assert.equal(res.json.documents_folder.connected, true);
    assert.equal(res.json.documents_folder.connector_id, 'docs');
    assert.equal(res.json.signed_in.access, 'admin');
    assert.equal(res.json.signed_in.kind, 'key');
    const hello = s.stubCalls().find((c) => c.initialize);
    assert.equal(hello.initialize.clientInfo.name, 'ModelBrain RAG');
  } finally {
    await s.close();
  }
});

test('status and search say so when the folder is not connected or ModelBrain is missing', async () => {
  const off = await startServer({ connected: false });
  try {
    const status = await off.call('GET', '/v1/status');
    assert.equal(status.json.documents_folder.connected, false);
    assert.match(status.json.documents_folder.message, /Add Vault/);
    const search = await off.call('POST', '/v1/search', { body: { query: 'refunds' } });
    assert.equal(search.status, 409);
    assert.equal(search.json.error.code, 'documents_folder_not_connected');
    assert.ok(search.json.error.message.includes(off.docsDir));
  } finally {
    await off.close();
  }
  const none = await startServer({ installed: false });
  try {
    const status = await none.call('GET', '/v1/status');
    assert.equal(status.json.modelbrain.installed, false);
    const search = await none.call('POST', '/v1/search', { body: { query: 'refunds' } });
    assert.equal(search.status, 503);
    assert.equal(search.json.error.code, 'modelbrain_not_installed');
    assert.match(search.json.error.message, /modelbrain\.net/);
  } finally {
    await none.close();
  }
});

test('documents: add, list, replace, delete, and collections', async () => {
  const s = await startServer();
  try {
    const put = await s.call('PUT', '/v1/collections/handbook/documents/refunds.md', { raw: '# Refunds\n14 days.' });
    assert.equal(put.status, 201);
    assert.equal(put.json.replaced, false);
    assert.equal(fs.readFileSync(path.join(s.docsDir, 'handbook', 'refunds.md'), 'utf8'), '# Refunds\n14 days.');
    const again = await s.call('PUT', '/v1/collections/handbook/documents/refunds.md', { raw: '# Refunds\n30 days.' });
    assert.equal(again.status, 200);
    assert.equal(again.json.replaced, true);
    const text = await s.call('POST', '/v1/collections/handbook/documents', { body: { name: 'hours.txt', text: 'Open 9 to 5.' } });
    assert.equal(text.status, 201);

    const cols = await s.call('GET', '/v1/collections');
    assert.deepEqual(cols.json.collections, [{ name: 'handbook', documents: 2, truncated: false }]);
    assert.deepEqual(cols.json.skipped, []);
    const docs = await s.call('GET', '/v1/collections/handbook/documents');
    assert.deepEqual(docs.json.documents.map((d) => d.name), ['hours.txt', 'refunds.md']);
    assert.ok(docs.json.documents.every((d) => d.searchable));

    // No temp files are left where ModelBrain would index them.
    assert.deepEqual(fs.readdirSync(path.join(s.docsDir, 'handbook')).sort(), ['hours.txt', 'refunds.md']);
    assert.deepEqual(fs.readdirSync(path.join(s.docsDir, '.modelbrain-rag-tmp')), []);

    assert.equal((await s.call('DELETE', '/v1/collections/handbook')).status, 409);
    assert.equal((await s.call('DELETE', '/v1/collections/handbook/documents/refunds.md')).status, 200);
    assert.equal((await s.call('DELETE', '/v1/collections/handbook/documents/refunds.md')).status, 404);
    assert.equal((await s.call('DELETE', '/v1/collections/handbook/documents/hours.txt')).status, 200);
    assert.equal((await s.call('DELETE', '/v1/collections/handbook')).status, 200);
    assert.equal((await s.call('GET', '/v1/collections/handbook/documents')).status, 404);
  } finally {
    await s.close();
  }
});

test('names that could leave the documents folder are refused', async () => {
  const s = await startServer();
  try {
    const outside = path.join(s.base, 'outside.md');
    for (const name of ['..', '.hidden.md', '%2e%2e%2fescape.md', 'a%2fb.md', 'a%5cb.md', 'con.md', 'trailing.md.', '%00.md']) {
      const res = await s.call('PUT', `/v1/collections/handbook/documents/${name}`, { raw: 'x' });
      assert.ok([400, 404].includes(res.status), `${name} gave ${res.status}`);
    }
    for (const col of ['..', '%2e%2e', '.git', 'a%2f..%2f..']) {
      const res = await s.call('PUT', `/v1/collections/${col}/documents/ok.md`, { raw: 'x' });
      assert.ok([400, 404].includes(res.status), `${col} gave ${res.status}`);
    }
    assert.equal(fs.existsSync(outside), false);
    assert.deepEqual(fs.readdirSync(s.base).sort(), ['config', 'stub.log', 'vault'].filter((n) => fs.existsSync(path.join(s.base, n))).sort());
  } finally {
    await s.close();
  }
});

test('links are not followed out of the documents folder', { skip: process.platform === 'win32' }, async () => {
  const s = await startServer();
  try {
    const outsideDir = path.join(s.base, 'outside');
    fs.mkdirSync(outsideDir);
    fs.symlinkSync(outsideDir, path.join(s.docsDir, 'linked'));
    const viaDir = await s.call('PUT', '/v1/collections/linked/documents/a.md', { raw: 'x' });
    assert.equal(viaDir.status, 409);
    assert.deepEqual(fs.readdirSync(outsideDir), []);

    fs.mkdirSync(path.join(s.docsDir, 'real'));
    const victim = path.join(s.base, 'victim.md');
    fs.writeFileSync(victim, 'keep');
    fs.symlinkSync(victim, path.join(s.docsDir, 'real', 'link.md'));
    assert.equal((await s.call('PUT', '/v1/collections/real/documents/link.md', { raw: 'overwritten' })).status, 409);
    assert.equal((await s.call('DELETE', '/v1/collections/real/documents/link.md')).status, 409);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'keep');
  } finally {
    await s.close();
  }
});

test('unsupported file types and oversized or empty uploads are refused', async () => {
  const s = await startServer({ maxUploadBytes: 1000 });
  try {
    const exe = await s.call('PUT', '/v1/collections/handbook/documents/tool.exe', { raw: 'x' });
    assert.equal(exe.status, 415);
    assert.match(exe.json.error.message, /pdf/);
    assert.equal((await s.call('PUT', '/v1/collections/handbook/documents/noext', { raw: 'x' })).status, 415);
    assert.equal((await s.call('PUT', '/v1/collections/handbook/documents/big.md', { raw: 'x'.repeat(2000) })).status, 413);
    assert.equal((await s.call('PUT', '/v1/collections/handbook/documents/empty.md', { raw: '' })).status, 400);
    assert.equal(fs.existsSync(path.join(s.docsDir, 'handbook', 'big.md')), false);
  } finally {
    await s.close();
  }
});

test('search asks ModelBrain for the right connector and folder and maps the hits', async () => {
  const s = await startServer({ docsSubdir: 'RAG Docs' });
  try {
    fs.mkdirSync(path.join(s.docsDir, 'handbook'));
    const res = await s.call('POST', '/v1/search', { body: { query: 'refund window', collection: 'handbook', k: 3, min_score: 0.5, merge_chunks: false } });
    assert.equal(res.status, 200);
    const recall = s.stubCalls().find((c) => c.tool === 'recall');
    assert.deepEqual(recall.args, {
      query: 'refund window',
      k: 3,
      scope: 'connector:docs',
      folder: 'RAG Docs/handbook',
      min_relevance: 0.5,
      collapse_sources: false,
    });
    assert.equal(res.json.count, 1);
    const hit = res.json.results[0];
    assert.equal(hit.collection, 'handbook');
    assert.equal(hit.document, 'refunds.md');
    assert.equal(hit.score, 0.81);
    assert.deepEqual(hit.headings, ['Policy', 'Refunds']);
    assert.equal(hit.text, 'Refunds are issued within 14 days.');

    const all = await s.call('POST', '/v1/search', { body: { query: 'anything' } });
    assert.equal(all.status, 200);
    const second = s.stubCalls().filter((c) => c.tool === 'recall')[1];
    assert.equal(second.args.folder.toLowerCase(), 'rag docs');
    assert.equal(second.args.k, 5);
  } finally {
    await s.close();
  }
});

test('search validates its input', async () => {
  const s = await startServer();
  try {
    assert.equal((await s.call('POST', '/v1/search', { body: {} })).json.error.code, 'invalid_query');
    assert.equal((await s.call('POST', '/v1/search', { body: { query: 'a', k: 0 } })).json.error.code, 'invalid_k');
    assert.equal((await s.call('POST', '/v1/search', { body: { query: 'a', k: 51 } })).json.error.code, 'invalid_k');
    assert.equal((await s.call('POST', '/v1/search', { body: { query: 'a', min_score: 2 } })).json.error.code, 'invalid_min_score');
    assert.equal((await s.call('POST', '/v1/search', { body: { query: 'a', collection: 'missing' } })).status, 404);
    assert.equal((await s.call('POST', '/v1/search', { raw: '{not json', headers: { 'Content-Type': 'application/json' } })).json.error.code, 'invalid_json');
    assert.equal(s.stubCalls().filter((c) => c.tool === 'recall').length, 0);
  } finally {
    await s.close();
  }
});

test('ModelBrain errors come back with their own code, and a crashed helper is restarted', async () => {
  const busy = await startServer({ stubEnv: { STUB_MODE: 'busy' } });
  try {
    const res = await busy.call('POST', '/v1/search', { body: { query: 'a' } });
    assert.equal(res.status, 503);
    assert.equal(res.json.error.code, 'store_busy');
  } finally {
    await busy.close();
  }
  const refuse = await startServer({ stubEnv: { STUB_MODE: 'refuse' } });
  try {
    const res = await refuse.call('POST', '/v1/search', { body: { query: 'a' } });
    assert.equal(res.status, 502);
    assert.match(res.json.error.message, /blocked/);
  } finally {
    await refuse.close();
  }
  const crash = await startServer({ stubEnv: { STUB_MODE: 'exit' } });
  try {
    const res = await crash.call('POST', '/v1/search', { body: { query: 'a' } });
    assert.equal(res.status, 503);
    process.env.STUB_MODE = '';
    const next = await crash.call('POST', '/v1/search', { body: { query: 'a' } });
    assert.equal(next.status, 200);
  } finally {
    await crash.close();
  }
});

test('access levels and collection limits are enforced', async () => {
  const s = await startServer();
  try {
    fs.mkdirSync(path.join(s.docsDir, 'public'));
    fs.mkdirSync(path.join(s.docsDir, 'private'));
    const reader = (await s.call('POST', '/v1/keys', { body: { name: 'reader', access: 'read' } })).json.key;
    const writer = (await s.call('POST', '/v1/keys', { body: { name: 'writer', access: 'write' } })).json.key;
    const scoped = (await s.call('POST', '/v1/keys', { body: { name: 'scoped', access: 'write', collections: ['public'] } })).json.key;

    // read: may search and list, may not write or manage keys.
    assert.equal((await s.call('POST', '/v1/search', { key: reader, body: { query: 'a' } })).status, 200);
    assert.equal((await s.call('GET', '/v1/collections', { key: reader })).status, 200);
    assert.equal((await s.call('PUT', '/v1/collections/public/documents/a.md', { key: reader, raw: 'x' })).status, 403);
    assert.equal((await s.call('DELETE', '/v1/collections/public', { key: reader })).status, 403);
    assert.equal((await s.call('GET', '/v1/keys', { key: reader })).status, 403);

    // write: may add documents, may not manage keys.
    assert.equal((await s.call('PUT', '/v1/collections/public/documents/a.md', { key: writer, raw: 'x' })).status, 201);
    assert.equal((await s.call('POST', '/v1/keys', { key: writer, body: { name: 'x' } })).status, 403);
    assert.equal((await s.call('DELETE', `/v1/keys/${s.keys.list()[0].id}`, { key: writer })).status, 403);

    // limited to "public": cannot see, read, write or search "private".
    const seen = await s.call('GET', '/v1/collections', { key: scoped });
    assert.deepEqual(seen.json.collections.map((c) => c.name), ['public']);
    assert.equal((await s.call('GET', '/v1/collections/private/documents', { key: scoped })).status, 403);
    assert.equal((await s.call('PUT', '/v1/collections/private/documents/a.md', { key: scoped, raw: 'x' })).status, 403);
    assert.equal((await s.call('POST', '/v1/collections', { key: scoped, body: { name: 'private2' } })).status, 403);
    assert.equal((await s.call('POST', '/v1/search', { key: scoped, body: { query: 'a', collection: 'private' } })).status, 403);
    assert.equal((await s.call('POST', '/v1/search', { key: scoped, body: { query: 'a', collection: 'missing' } })).status, 403);
    assert.equal((await s.call('POST', '/v1/search', { key: scoped, body: { query: 'a' } })).json.error.code, 'collection_required');
    assert.equal((await s.call('POST', '/v1/search', { key: scoped, body: { query: 'a', collection: 'public' } })).status, 200);
    assert.equal((await s.call('PUT', '/v1/collections/public/documents/b.md', { key: scoped, raw: 'x' })).status, 201);
    assert.equal(fs.existsSync(path.join(s.docsDir, 'private', 'a.md')), false);
  } finally {
    await s.close();
  }
});

test('key management over HTTP: the key is shown once and the last admin key cannot be revoked', async () => {
  const s = await startServer();
  try {
    const made = await s.call('POST', '/v1/keys', { body: { name: 'app', access: 'read' } });
    assert.equal(made.status, 201);
    assert.match(made.json.key, /^mbrag_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
    const listed = await s.call('GET', '/v1/keys');
    assert.equal(listed.json.keys.length, 2);
    assert.ok(listed.json.keys.every((k) => !('key' in k) && !('hash' in k)));
    assert.ok(!fs.readFileSync(path.join(s.base, 'config', 'keys.json'), 'utf8').includes(made.json.key));

    const adminId = listed.json.keys.find((k) => k.access === 'admin').id;
    const last = await s.call('DELETE', `/v1/keys/${adminId}`);
    assert.equal(last.status, 409);
    assert.equal(last.json.error.code, 'last_admin_key');
    assert.equal((await s.call('DELETE', '/v1/keys/nope')).status, 404);
    assert.equal((await s.call('POST', '/v1/keys', { body: { name: '', access: 'read' } })).status, 400);
    assert.equal((await s.call('POST', '/v1/keys', { body: { name: 'x', access: 'root' } })).status, 400);
    assert.equal((await s.call('POST', '/v1/keys', { body: { name: 'x', access: 'admin', collections: ['a'] } })).status, 400);
    assert.equal((await s.call('POST', '/v1/keys', { body: { name: 'x', access: 'read', collections: ['../a'] } })).status, 400);
  } finally {
    await s.close();
  }
});

test('unknown addresses and methods give 404', async () => {
  const s = await startServer();
  try {
    assert.equal((await s.call('GET', '/nothing')).status, 404);
    assert.equal((await s.call('GET', '/v1/nothing')).status, 404);
    assert.equal((await s.call('PATCH', '/v1/collections')).status, 404);
    assert.equal((await s.call('GET', '/v1/%E0%A4%A')).status, 400);
  } finally {
    await s.close();
  }
});
