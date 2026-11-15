'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { KeyStore, allows, allowsCollection } = require('../lib/keys.js');

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbrag-keys-'));
  return { dir, file: path.join(dir, 'nested', 'keys.json') };
}

test('a key verifies, a changed key does not, and only hashes are stored', () => {
  const { dir, file } = tempFile();
  try {
    const store = new KeyStore(file);
    const { key, record } = store.create({ name: 'app', access: 'write' });
    assert.equal(store.verify(key).id, record.id);
    assert.equal(store.verify(key.slice(0, -1) + (key.endsWith('A') ? 'B' : 'A')), null);
    assert.equal(store.verify(''), null);
    assert.equal(store.verify(undefined), null);
    assert.equal(store.verify('mbrag_x'), null);
    assert.equal(store.verify('x'.repeat(5000)), null);
    const onDisk = fs.readFileSync(file, 'utf8');
    assert.ok(!onDisk.includes(key));
    assert.ok(onDisk.includes(record.id));
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a key made by another process works without a restart, and so does a revoke', () => {
  const { dir, file } = tempFile();
  try {
    const server = new KeyStore(file);
    const cli = new KeyStore(file);
    const admin = cli.create({ name: 'admin', access: 'admin' });
    const extra = cli.create({ name: 'extra', access: 'read' });
    assert.equal(server.verify(extra.key).name, 'extra');
    cli.revoke(extra.record.id);
    assert.equal(server.verify(extra.key), null);
    assert.equal(server.verify(admin.key).access, 'admin');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('last-used times are kept across a flush and do not undo a revoke made elsewhere', () => {
  const { dir, file } = tempFile();
  try {
    const server = new KeyStore(file);
    const cli = new KeyStore(file);
    cli.create({ name: 'admin', access: 'admin' });
    const a = cli.create({ name: 'a', access: 'read' });
    const b = cli.create({ name: 'b', access: 'read' });
    assert.ok(server.verify(a.key));
    assert.ok(server.verify(b.key));
    // Make sure the next write lands on a later timestamp than the load.
    const later = new Date(Date.now() + 5000);
    cli.revoke(b.record.id);
    fs.utimesSync(file, later, later);
    server.flush();
    const after = new KeyStore(file).list();
    assert.ok(after.find((k) => k.id === a.record.id).last_used);
    assert.ok(after.find((k) => k.id === b.record.id).revoked);
    assert.equal(server.verify(b.key), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the last admin key cannot be revoked; pruning removes revoked keys', () => {
  const { dir, file } = tempFile();
  try {
    const store = new KeyStore(file);
    assert.equal(store.hasActiveAdmin(), false);
    const first = store.create({ name: 'admin', access: 'admin' });
    assert.equal(store.hasActiveAdmin(), true);
    assert.throws(() => store.revoke(first.record.id), /only admin key/);
    const second = store.create({ name: 'admin2', access: 'admin' });
    store.revoke(first.record.id);
    assert.equal(store.verify(first.key), null);
    assert.throws(() => store.revoke(second.record.id), /only admin key/);
    assert.equal(store.prune(), 1);
    assert.equal(store.list().length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('access levels are ordered and collection limits ignore case', () => {
  assert.equal(allows({ access: 'read' }, 'read'), true);
  assert.equal(allows({ access: 'read' }, 'write'), false);
  assert.equal(allows({ access: 'write' }, 'read'), true);
  assert.equal(allows({ access: 'write' }, 'admin'), false);
  assert.equal(allows({ access: 'admin' }, 'write'), true);
  assert.equal(allowsCollection({ collections: null }, 'anything'), true);
  assert.equal(allowsCollection({ collections: ['Public'] }, 'public'), true);
  assert.equal(allowsCollection({ collections: ['Public'] }, 'private'), false);
});

test('every generated key verifies, whatever characters its secret holds', () => {
  const { dir, file } = tempFile();
  try {
    const store = new KeyStore(file);
    let sawUnderscore = false;
    for (let i = 0; i < 200; i += 1) {
      const { key, record } = store.create({ name: `k${i}`, access: 'read' });
      if (key.slice('mbrag_'.length + 13).includes('_')) sawUnderscore = true;
      assert.equal(store.verify(key).id, record.id, key);
    }
    assert.ok(sawUnderscore, 'expected at least one secret containing an underscore in 200 keys');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
