'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { startServer } = require('../test-support/helpers.js');
const { UserStore } = require('../lib/users.js');

function tempUsers(options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbrag-users-'));
  return { dir, store: new UserStore(path.join(dir, 'users.json'), options) };
}

test('sign in with a username and password, use the session, sign out', async () => {
  const s = await startServer();
  try {
    const wrong = await s.login('admin', 'not-the-password');
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.error.code, 'invalid_login');
    assert.equal((await s.login('nobody', 'admin-password-1')).json.error.code, 'invalid_login');
    assert.equal((await s.login('', '')).status, 401);
    assert.equal((await s.call('POST', '/v1/login', { key: null, body: {} })).status, 401);

    const ok = await s.login('ADMIN', 'admin-password-1');
    assert.equal(ok.status, 200);
    assert.match(ok.json.token, /^mbrags_[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(ok.json.signed_in, { kind: 'user', name: 'admin', access: 'admin', collections: null });
    const token = ok.json.token;

    const me = await s.call('GET', '/v1/me', { key: token });
    assert.deepEqual(me.json, { kind: 'user', name: 'admin', access: 'admin', collections: null });
    assert.equal((await s.call('GET', '/v1/keys', { key: token })).status, 200);
    assert.equal((await s.call('POST', '/v1/search', { key: token, body: { query: 'a' } })).status, 200);

    assert.equal((await s.call('POST', '/v1/logout', { key: token })).status, 200);
    assert.equal((await s.call('GET', '/v1/me', { key: token })).status, 401);
    // The password and its hash never appear in any listing.
    const listed = JSON.stringify((await s.call('GET', '/v1/users')).json);
    assert.ok(!listed.includes('hash') && !listed.includes('salt') && !listed.includes('admin-password-1'));
    const onDisk = fs.readFileSync(path.join(s.base, 'config', 'users.json'), 'utf8');
    assert.ok(!onDisk.includes('admin-password-1'));
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(s.base, 'config', 'users.json')).mode & 0o777, 0o600);
  } finally {
    await s.close();
  }
});

test('user accounts follow the same access levels and collection limits as keys', async () => {
  const s = await startServer();
  try {
    fs.mkdirSync(path.join(s.docsDir, 'public'));
    fs.mkdirSync(path.join(s.docsDir, 'private'));
    assert.equal((await s.call('POST', '/v1/users', { body: { username: 'reader', password: 'reader-password', access: 'read' } })).status, 201);
    assert.equal((await s.call('POST', '/v1/users', { body: { username: 'scoped', password: 'scoped-password', access: 'write', collections: ['public'] } })).status, 201);
    const reader = (await s.login('reader', 'reader-password')).json.token;
    const scoped = (await s.login('scoped', 'scoped-password')).json.token;

    assert.equal((await s.call('POST', '/v1/search', { key: reader, body: { query: 'a' } })).status, 200);
    assert.equal((await s.call('PUT', '/v1/collections/public/documents/a.md', { key: reader, raw: 'x' })).status, 403);
    for (const route of ['/v1/users', '/v1/keys', '/v1/settings']) {
      assert.equal((await s.call('GET', route, { key: reader })).status, 403, route);
    }
    assert.equal((await s.call('POST', '/v1/users', { key: reader, body: { username: 'x', password: 'long-enough-pw', access: 'admin' } })).status, 403);
    assert.equal((await s.call('PUT', '/v1/users/reader', { key: reader, body: { access: 'admin' } })).status, 403);

    assert.equal((await s.call('PUT', '/v1/collections/public/documents/a.md', { key: scoped, raw: 'x' })).status, 201);
    assert.equal((await s.call('PUT', '/v1/collections/private/documents/a.md', { key: scoped, raw: 'x' })).status, 403);
    assert.equal((await s.call('POST', '/v1/search', { key: scoped, body: { query: 'a' } })).json.error.code, 'collection_required');
    const status = await s.call('GET', '/v1/status', { key: scoped });
    assert.equal(status.json.documents_folder.path, null);
    const cols = await s.call('GET', '/v1/collections', { key: scoped });
    assert.deepEqual(cols.json.collections.map((c) => c.name), ['public']);
    assert.equal(cols.json.folder, undefined);
  } finally {
    await s.close();
  }
});

test('changing access, disabling, removing or resetting a user ends their sessions at once', async () => {
  const s = await startServer();
  try {
    for (const name of ['a', 'b', 'c', 'd']) {
      assert.equal((await s.call('POST', '/v1/users', { body: { username: name, password: `password-for-${name}`, access: 'write' } })).status, 201);
    }
    const tokens = {};
    for (const name of ['a', 'b', 'c', 'd']) tokens[name] = (await s.login(name, `password-for-${name}`)).json.token;

    assert.equal((await s.call('PUT', '/v1/users/a', { body: { access: 'read' } })).json.access, 'read');
    assert.equal((await s.call('GET', '/v1/me', { key: tokens.a })).status, 401);
    assert.equal((await s.login('a', 'password-for-a')).json.signed_in.access, 'read');

    assert.equal((await s.call('PUT', '/v1/users/b', { body: { disabled: true } })).json.disabled, true);
    assert.equal((await s.call('GET', '/v1/me', { key: tokens.b })).status, 401);
    assert.equal((await s.login('b', 'password-for-b')).status, 401);

    assert.equal((await s.call('DELETE', '/v1/users/c')).status, 200);
    assert.equal((await s.call('GET', '/v1/me', { key: tokens.c })).status, 401);
    assert.equal((await s.call('DELETE', '/v1/users/c')).status, 404);

    assert.equal((await s.call('PUT', '/v1/users/d', { body: { password: 'a-brand-new-password' } })).status, 200);
    assert.equal((await s.call('GET', '/v1/me', { key: tokens.d })).status, 401);
    assert.equal((await s.login('d', 'password-for-d')).status, 401);
    assert.equal((await s.login('d', 'a-brand-new-password')).status, 200);
  } finally {
    await s.close();
  }
});

test('a user changes their own password and stays signed in; API keys have no password', async () => {
  const s = await startServer();
  try {
    const first = (await s.login('admin', 'admin-password-1')).json.token;
    const other = (await s.login('admin', 'admin-password-1')).json.token;
    const bad = await s.call('PUT', '/v1/me/password', { key: first, body: { current: 'wrong', new: 'another-password-2' } });
    assert.equal(bad.status, 401);
    assert.equal((await s.call('PUT', '/v1/me/password', { key: first, body: { current: 'admin-password-1', new: 'short' } })).status, 400);
    const changed = await s.call('PUT', '/v1/me/password', { key: first, body: { current: 'admin-password-1', new: 'another-password-2' } });
    assert.equal(changed.status, 200);
    assert.equal((await s.call('GET', '/v1/me', { key: changed.json.token })).status, 200);
    assert.equal((await s.call('GET', '/v1/me', { key: first })).status, 401);
    assert.equal((await s.call('GET', '/v1/me', { key: other })).status, 401);
    assert.equal((await s.login('admin', 'admin-password-1')).status, 401);
    assert.equal((await s.call('PUT', '/v1/me/password', { body: { current: 'x', new: 'another-password-3' } })).json.error.code, 'not_a_user');
  } finally {
    await s.close();
  }
});

test('the last admin user cannot be demoted, disabled or removed; bad input is refused', async () => {
  const s = await startServer();
  try {
    assert.equal((await s.call('PUT', '/v1/users/admin', { body: { access: 'read' } })).json.error.code, 'last_admin_user');
    assert.equal((await s.call('PUT', '/v1/users/admin', { body: { disabled: true } })).json.error.code, 'last_admin_user');
    assert.equal((await s.call('DELETE', '/v1/users/admin')).json.error.code, 'last_admin_user');
    const bad = [
      { username: 'bad name', password: 'long-enough-pw', access: 'read' },
      { username: '../x', password: 'long-enough-pw', access: 'read' },
      { username: 'ok', password: 'short', access: 'read' },
      { username: 'ok', password: 'long-enough-pw', access: 'root' },
      { username: 'ok', password: 'long-enough-pw', access: 'admin', collections: ['a'] },
      { username: 'Admin', password: 'long-enough-pw', access: 'read' },
    ];
    for (const body of bad) {
      const res = await s.call('POST', '/v1/users', { body });
      assert.ok([400, 409].includes(res.status), JSON.stringify(body));
    }
    assert.equal((await s.call('GET', '/v1/users')).json.users.length, 1);
  } finally {
    await s.close();
  }
});

test('wrong passwords lock the username for a while, and the lock lifts', async () => {
  let clock = 1000000;
  const { dir, store } = tempUsers({ now: () => clock });
  try {
    await store.create({ username: 'sam', password: 'correct-horse-battery', access: 'read' });
    for (let i = 0; i < 5; i += 1) {
      await assert.rejects(store.login('sam', 'wrong-password'), /not accepted/);
    }
    await assert.rejects(store.login('sam', 'correct-horse-battery'), /Too many wrong passwords/);
    await assert.rejects(store.login('SAM', 'correct-horse-battery'), /Too many wrong passwords/);
    clock += 31000;
    const session = await store.login('sam', 'correct-horse-battery');
    assert.ok(store.verifySession(session.token));
    // A name that does not exist is locked the same way, so it cannot be told apart.
    for (let i = 0; i < 5; i += 1) await assert.rejects(store.login('ghost', 'x'), /not accepted/);
    await assert.rejects(store.login('ghost', 'x'), /Too many wrong passwords/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sessions end after eight idle hours and after a day in any case', async () => {
  let clock = 5000000;
  const { dir, store } = tempUsers({ now: () => clock });
  try {
    await store.create({ username: 'sam', password: 'correct-horse-battery', access: 'read' });
    const idle = (await store.login('sam', 'correct-horse-battery')).token;
    clock += 7 * 3600 * 1000;
    assert.ok(store.verifySession(idle));
    clock += 9 * 3600 * 1000;
    assert.equal(store.verifySession(idle), null);

    const busy = (await store.login('sam', 'correct-horse-battery')).token;
    for (let hour = 0; hour < 23; hour += 1) {
      clock += 3600 * 1000;
      assert.ok(store.verifySession(busy), `hour ${hour}`);
    }
    clock += 2 * 3600 * 1000;
    assert.equal(store.verifySession(busy), null);
    assert.equal(store.verifySession('mbrags_' + 'A'.repeat(43)), null);
    assert.equal(store.verifySession('nonsense'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
