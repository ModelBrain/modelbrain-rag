'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { startServer } = require('../test-support/helpers.js');
const config = require('../lib/config.js');

const WORK = '01PARTITIONWORK00000000000';

test('nothing ModelBrain holds is reachable until an admin shares it', async () => {
  const s = await startServer();
  try {
    const reader = (await s.call('POST', '/v1/keys', { body: { name: 'r', access: 'read' } })).json.key;
    assert.deepEqual((await s.call('GET', '/v1/vaults', { key: reader })).json.vaults, []);
    assert.deepEqual((await s.call('GET', '/v1/partitions', { key: reader })).json.partitions, []);
    assert.equal((await s.call('POST', '/v1/search', { key: reader, body: { query: 'a', vault: 'notes' } })).status, 404);
    assert.equal((await s.call('POST', '/v1/search', { key: reader, body: { query: 'a', partition: 'Work' } })).status, 404);
    // Even an admin must share first.
    assert.equal((await s.call('POST', '/v1/search', { body: { query: 'a', vault: 'mail' } })).status, 404);
    assert.equal((await s.call('POST', '/v1/search', { body: { query: 'a', partition: WORK } })).status, 404);
    assert.equal(s.stubCalls().filter((c) => c.tool === 'recall').length, 0);
  } finally {
    await s.close();
  }
});

test('an admin lists every vault and partition and shares them; others see only shared ones', async () => {
  const s = await startServer();
  try {
    const all = await s.call('GET', '/v1/vaults');
    assert.deepEqual(all.json.vaults.map((v) => [v.id, v.kind, v.shared, v.documents_folder]), [
      ['docs', 'folder', false, true],
      ['notes', 'folder', false, false],
      ['mail', 'mail', false, false],
    ]);
    assert.equal(all.json.vaults[1].root, '/somewhere/notes');
    const parts = await s.call('GET', '/v1/partitions');
    assert.deepEqual(parts.json.partitions.map((p) => [p.name, p.is_default, p.shared]), [['unsorted', true, false], ['Work', false, false]]);

    assert.equal((await s.call('PUT', '/v1/vaults/notes', { body: { shared: true } })).status, 200);
    assert.equal((await s.call('PUT', `/v1/partitions/${WORK}`, { body: { shared: true } })).status, 200);
    assert.equal((await s.call('PUT', '/v1/vaults/nope', { body: { shared: true } })).status, 404);
    assert.equal((await s.call('PUT', '/v1/partitions/nope', { body: { shared: true } })).status, 404);
    assert.equal((await s.call('PUT', '/v1/vaults/notes', { body: { shared: 'yes' } })).status, 400);
    assert.deepEqual(config.loadSettings(path.join(s.base, 'config')).shared, { vaults: ['notes'], partitions: [WORK] });

    const reader = (await s.call('POST', '/v1/keys', { body: { name: 'r', access: 'read' } })).json.key;
    const seen = await s.call('GET', '/v1/vaults', { key: reader });
    assert.deepEqual(seen.json.vaults, [{ id: 'notes', kind: 'folder', files: 40, shared: true, documents_folder: false }]);
    assert.deepEqual((await s.call('GET', '/v1/partitions', { key: reader })).json.partitions, [{ id: WORK, name: 'Work', is_default: false, shared: true }]);
    // Only an admin may share.
    const writer = (await s.call('POST', '/v1/keys', { body: { name: 'w', access: 'write' } })).json.key;
    assert.equal((await s.call('PUT', '/v1/vaults/mail', { key: writer, body: { shared: true } })).status, 403);
    assert.equal((await s.call('PUT', `/v1/partitions/${WORK}`, { key: writer, body: { shared: false } })).status, 403);

    assert.equal((await s.call('PUT', '/v1/vaults/notes', { body: { shared: false } })).status, 200);
    assert.deepEqual((await s.call('GET', '/v1/vaults', { key: reader })).json.vaults, []);
    assert.equal((await s.call('POST', '/v1/search', { key: reader, body: { query: 'a', vault: 'notes' } })).status, 404);
  } finally {
    await s.close();
  }
});

test('a search targets one vault, optionally one folder in it', async () => {
  const s = await startServer();
  try {
    await s.call('PUT', '/v1/vaults/notes', { body: { shared: true } });
    const res = await s.call('POST', '/v1/search', { body: { query: 'refunds', vault: 'notes', k: 7 } });
    assert.equal(res.status, 200);
    assert.equal(res.json.vault, 'notes');
    assert.equal(res.json.collection, null);
    assert.equal(res.json.results[0].document, 'refunds.md');
    let recall = s.stubCalls().filter((c) => c.tool === 'recall').pop();
    assert.deepEqual(recall.args, { query: 'refunds', k: 7, scope: 'connector:notes' });

    const inFolder = await s.call('POST', '/v1/search', { body: { query: 'refunds', vault: 'notes', folder: 'Projects/Alpha' } });
    assert.equal(inFolder.status, 200);
    recall = s.stubCalls().filter((c) => c.tool === 'recall').pop();
    assert.deepEqual(recall.args, { query: 'refunds', k: 5, scope: 'connector:notes', folder: 'Projects/Alpha' });
    assert.equal(inFolder.json.results[0].document, 'Projects/Alpha/refunds.md');

    for (const folder of ['../x', 'a/../../b', 'a\\..\\b', 5, 'x'.repeat(501)]) {
      assert.equal((await s.call('POST', '/v1/search', { body: { query: 'a', vault: 'notes', folder } })).status, 400, String(folder).slice(0, 20));
    }
    assert.equal((await s.call('POST', '/v1/search', { body: { query: 'a', folder: 'x' } })).json.error.code, 'invalid_folder');
    assert.equal((await s.call('POST', '/v1/search', { body: { query: 'a', vault: 'notes', collection: 'x' } })).json.error.code, 'one_target');
    assert.equal((await s.call('POST', '/v1/search', { body: { query: 'a', vault: 'notes', partition: 'Work' } })).json.error.code, 'one_target');
  } finally {
    await s.close();
  }
});

test('a search targets one partition by id or by name', async () => {
  const s = await startServer();
  try {
    await s.call('PUT', `/v1/partitions/${WORK}`, { body: { shared: true } });
    for (const name of [WORK, 'Work', 'work']) {
      const res = await s.call('POST', '/v1/search', { body: { query: 'refunds', partition: name } });
      assert.equal(res.status, 200, name);
      assert.deepEqual(res.json.partition, { id: WORK, name: 'Work' });
      const recall = s.stubCalls().filter((c) => c.tool === 'recall').pop();
      assert.deepEqual(recall.args, { query: 'refunds', k: 5, scope: 'all', partition_scope: `id:${WORK}` });
    }
    // Archived and unshared partitions answer the same as ones that do not exist.
    for (const name of ['Old', 'unsorted', 'nope', 'all', 'all_active', 'current', 'id:00000000000000000000000000']) {
      const res = await s.call('POST', '/v1/search', { body: { query: 'a', partition: name } });
      assert.equal(res.status, 404, name);
      assert.equal(res.json.error.code, 'partition_not_available');
    }
  } finally {
    await s.close();
  }
});

test('hits from anywhere but the place that was asked for are dropped', async () => {
  const hits = [
    { key: '1', text: 'right vault', relevance: 0.9, source: 'connector', connector_id: 'notes', partition_id: WORK, source_uri: 'a.md' },
    { key: '2', text: 'wrong vault', relevance: 0.8, source: 'connector', connector_id: 'mail', partition_id: 'OTHER', source_uri: 'inbox/1.eml' },
    { key: '3', text: 'a memory', relevance: 0.7, source: 'user', partition_id: WORK },
    { key: '4', text: 'no ids at all', relevance: 0.6, source: 'connector', source_uri: '../../etc/passwd' },
  ];
  const s = await startServer({ stubEnv: { STUB_HITS: JSON.stringify(hits) } });
  try {
    await s.call('PUT', '/v1/vaults/notes', { body: { shared: true } });
    await s.call('PUT', `/v1/partitions/${WORK}`, { body: { shared: true } });
    fs.mkdirSync(path.join(s.docsDir, 'handbook'));

    const vault = await s.call('POST', '/v1/search', { body: { query: 'a', vault: 'notes' } });
    assert.deepEqual(vault.json.results.map((r) => r.text), ['right vault']);

    const part = await s.call('POST', '/v1/search', { body: { query: 'a', partition: 'Work' } });
    assert.deepEqual(part.json.results.map((r) => [r.text, r.source, r.document]), [['right vault', 'document', 'a.md'], ['a memory', 'memory', null]]);

    const col = await s.call('POST', '/v1/search', { body: { query: 'a', collection: 'handbook' } });
    assert.deepEqual(col.json.results, []);
  } finally {
    await s.close();
  }
});

test('a limited key or user reaches a vault or partition only when granted it', async () => {
  const s = await startServer();
  try {
    fs.mkdirSync(path.join(s.docsDir, 'public'));
    await s.call('PUT', '/v1/vaults/notes', { body: { shared: true } });
    await s.call('PUT', '/v1/vaults/mail', { body: { shared: true } });
    await s.call('PUT', `/v1/partitions/${WORK}`, { body: { shared: true } });

    const onlyCol = (await s.call('POST', '/v1/keys', { body: { name: 'c', access: 'read', collections: ['public'] } })).json.key;
    assert.deepEqual((await s.call('GET', '/v1/vaults', { key: onlyCol })).json.vaults, []);
    assert.deepEqual((await s.call('GET', '/v1/partitions', { key: onlyCol })).json.partitions, []);
    assert.equal((await s.call('POST', '/v1/search', { key: onlyCol, body: { query: 'a', vault: 'notes' } })).status, 404);
    assert.equal((await s.call('POST', '/v1/search', { key: onlyCol, body: { query: 'a', partition: 'Work' } })).status, 404);

    const made = await s.call('POST', '/v1/keys', { body: { name: 'v', access: 'read', collections: ['vault:notes', `partition:${WORK}`] } });
    assert.equal(made.status, 201);
    const granted = made.json.key;
    assert.deepEqual((await s.call('GET', '/v1/vaults', { key: granted })).json.vaults.map((v) => v.id), ['notes']);
    assert.equal((await s.call('POST', '/v1/search', { key: granted, body: { query: 'a', vault: 'notes' } })).status, 200);
    assert.equal((await s.call('POST', '/v1/search', { key: granted, body: { query: 'a', partition: 'Work' } })).status, 200);
    assert.equal((await s.call('POST', '/v1/search', { key: granted, body: { query: 'a', vault: 'mail' } })).status, 404);
    assert.equal((await s.call('POST', '/v1/search', { key: granted, body: { query: 'a', collection: 'public' } })).status, 403);
    assert.equal((await s.call('POST', '/v1/search', { key: granted, body: { query: 'a' } })).json.error.code, 'collection_required');
    // A grant is not a collection name: it cannot be used to reach a folder.
    assert.deepEqual((await s.call('GET', '/v1/collections', { key: granted })).json.collections, []);

    assert.equal((await s.call('POST', '/v1/users', { body: { username: 'vera', password: 'vera-password-1', access: 'read', collections: ['vault:notes'] } })).status, 201);
    const vera = (await s.login('vera', 'vera-password-1')).json.token;
    assert.equal((await s.call('POST', '/v1/search', { key: vera, body: { query: 'a', vault: 'notes' } })).status, 200);
    assert.equal((await s.call('POST', '/v1/search', { key: vera, body: { query: 'a', vault: 'mail' } })).status, 404);
    for (const bad of [['vault:'], ['vault:a/b'], ['partition:a\\b'], ['other:x']]) {
      assert.equal((await s.call('POST', '/v1/keys', { body: { name: 'x', access: 'read', collections: bad } })).status, 400, bad[0]);
    }
  } finally {
    await s.close();
  }
});

test('shared lists in settings are checked on load', () => {
  assert.deepEqual(config.checkShared(undefined), { vaults: [], partitions: [] });
  assert.deepEqual(config.checkShared({ vaults: ['a', 'a', 'b'] }), { vaults: ['a', 'b'], partitions: [] });
  for (const bad of ['x', [], { vaults: 'a' }, { partitions: [5] }, { vaults: [''] }]) {
    assert.throws(() => config.checkShared(bad), /shared/);
  }
});

test('a search result links to the whole document, which is sent as a download and never as a page', async () => {
  const hits = [
    { key: '1', text: 'top level', relevance: 0.9, source: 'connector', connector_id: 'docs', source_uri: 'handbook/Refund policy.md' },
    { key: '2', text: 'in a subfolder', relevance: 0.8, source: 'connector', connector_id: 'docs', source_uri: 'handbook/old/notes.md' },
  ];
  const s = await startServer({ stubEnv: { STUB_HITS: JSON.stringify(hits) } });
  try {
    fs.mkdirSync(path.join(s.docsDir, 'handbook', 'old'), { recursive: true });
    fs.mkdirSync(path.join(s.docsDir, 'private'));
    fs.writeFileSync(path.join(s.docsDir, 'handbook', 'Refund policy.md'), '# Refunds\n\nWithin 14 days.\n');
    fs.writeFileSync(path.join(s.docsDir, 'handbook', 'page.html'), '<script>alert(1)</script>');
    fs.writeFileSync(path.join(s.docsDir, 'private', 'pay.md'), 'secret');

    const found = await s.call('POST', '/v1/search', { body: { query: 'refunds', collection: 'handbook' } });
    assert.equal(found.json.results[0].document_url, '/v1/collections/handbook/documents/Refund%20policy.md');
    assert.equal(found.json.results[1].document_url, null);

    const reader = (await s.call('POST', '/v1/keys', { body: { name: 'r', access: 'read', collections: ['handbook'] } })).json.key;
    const res = await fetch(s.url + found.json.results[0].document_url, { headers: { Authorization: `Bearer ${reader}` } });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '# Refunds\n\nWithin 14 days.\n');
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.equal(res.headers.get('content-disposition'), "attachment; filename*=UTF-8''Refund%20policy.md");
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-security-policy'), /sandbox/);

    const page = await fetch(`${s.url}/v1/collections/handbook/documents/page.html`, { headers: { Authorization: `Bearer ${reader}` } });
    assert.equal(page.headers.get('content-type'), 'application/octet-stream');
    assert.match(page.headers.get('content-disposition'), /^attachment/);

    assert.equal((await s.call('GET', '/v1/collections/private/documents/pay.md', { key: reader })).status, 403);
    assert.equal((await s.call('GET', '/v1/collections/handbook/documents/pay.md', { key: reader })).status, 404);
    assert.equal((await s.call('GET', '/v1/collections/handbook/documents/Refund%20policy.md', { key: null })).status, 401);
    for (const bad of ['..%2F..%2Fconfig%2Fusers.json', '..', '.hidden', 'old']) {
      const r = await s.call('GET', `/v1/collections/handbook/documents/${bad}`);
      assert.ok([400, 404, 409].includes(r.status), `${bad} gave ${r.status}`);
    }
    if (process.platform !== 'win32') {
      fs.symlinkSync(path.join(s.base, 'config', 'users.json'), path.join(s.docsDir, 'handbook', 'link.md'));
      assert.equal((await s.call('GET', '/v1/collections/handbook/documents/link.md')).status, 409);
    }
  } finally {
    await s.close();
  }
});
