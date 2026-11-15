'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { startServer } = require('../test-support/helpers.js');
const { UserStore } = require('../lib/users.js');

function tempUsers(options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbrag-hard-'));
  return { dir, store: new UserStore(path.join(dir, 'users.json'), options) };
}

test('a removed user\'s session does not carry over to a new user with the same name', async () => {
  const s = await startServer();
  try {
    await s.call('POST', '/v1/users', { body: { username: 'bob', password: 'bob-password-1', access: 'read' } });
    const old = (await s.login('bob', 'bob-password-1')).json.token;
    assert.equal((await s.call('DELETE', '/v1/users/bob')).status, 200);
    assert.equal((await s.call('POST', '/v1/users', { body: { username: 'Bob', password: 'another-password', access: 'admin' } })).status, 201);
    assert.equal((await s.call('GET', '/v1/me', { key: old })).status, 401);
    assert.equal((await s.call('GET', '/v1/users', { key: old })).status, 401);
  } finally {
    await s.close();
  }
});

test('access taken away while a request body is still arriving stops the request', async () => {
  const s = await startServer();
  try {
    await s.call('POST', '/v1/users', { body: { username: 'eve', password: 'eve-password-1', access: 'admin' } });
    const token = (await s.login('eve', 'eve-password-1')).json.token;
    const body = JSON.stringify({ name: 'backdoor', access: 'admin' });
    const reply = await new Promise((resolve, reject) => {
      const socket = net.connect(s.port, '127.0.0.1', async () => {
        socket.write(`POST /v1/keys HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`);
        await new Promise((r) => setTimeout(r, 150));
        const disabled = await s.call('PUT', '/v1/users/eve', { body: { disabled: true } });
        assert.equal(disabled.status, 200);
        socket.write(body);
      });
      let data = '';
      socket.on('data', (chunk) => { data += chunk; });
      socket.on('close', () => resolve(data));
      socket.on('error', reject);
    });
    assert.match(reply, /^HTTP\/1\.1 401/);
    assert.equal((await s.call('GET', '/v1/keys')).json.keys.some((k) => k.name === 'backdoor'), false);
  } finally {
    await s.close();
  }
});

test('guessing in parallel gets no more tries than guessing one at a time', async () => {
  const { dir, store } = tempUsers();
  try {
    await store.create({ username: 'sam', password: 'correct-horse-battery', access: 'read' });
    const guesses = [];
    for (let i = 0; i < 12; i += 1) guesses.push(store.login('sam', i === 11 ? 'correct-horse-battery' : `wrong-guess-${i}`).then(() => 'in', (err) => err.code));
    const results = await Promise.all(guesses);
    // Five wrong guesses are checked; the rest, including the right password
    // at the end of the line, are turned away by the lock.
    assert.equal(results.filter((r) => r === 'invalid_login').length, 5);
    assert.equal(results.filter((r) => r === 'too_many_attempts').length, 7);
    assert.equal(results.filter((r) => r === 'in').length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a flood of made-up usernames neither lifts a real lock nor ties up sign-in', async () => {
  let clock = 1000;
  const { dir, store } = tempUsers({ now: () => clock });
  try {
    await store.create({ username: 'sam', password: 'correct-horse-battery', access: 'read' });
    for (let i = 0; i < 5; i += 1) await assert.rejects(store.login('sam', 'wrong-password-x'));
    assert.ok(store.lockedFor('login:sam') > 0);
    // Fill the table without hashing: the bookkeeping is what is under test.
    for (let i = 0; i < 6000; i += 1) store.noteFailure(`login:junk${i}`, false);
    assert.ok(store.lockedFor('login:sam') > 0, 'the real lock survived the flood');
    assert.ok(store.failures.size <= 5001);
    await assert.rejects(store.login('sam', 'correct-horse-battery'), /Too many wrong passwords/);

    // More password checks at once than the cap are refused straight away.
    const burst = [];
    for (let i = 0; i < 40; i += 1) burst.push(store.login(`nobody${i}`, 'x').then(() => 'in', (err) => err.code));
    const codes = await Promise.all(burst);
    assert.equal(codes.filter((c) => c === 'invalid_login').length, 16);
    assert.equal(codes.filter((c) => c === 'too_many_attempts').length, 24);
    clock += 31000;
    assert.ok((await store.login('sam', 'correct-horse-battery')).token);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('one user cannot use up every session; their oldest session gives way', async () => {
  const { dir, store } = tempUsers();
  try {
    await store.create({ username: 'sam', password: 'correct-horse-battery', access: 'read' });
    const user = store.find(store.users, 'sam');
    const tokens = [];
    for (let i = 0; i < 14; i += 1) tokens.push(store.startSession(user).token);
    assert.equal(store.sessions.size, 10);
    assert.equal(store.verifySession(tokens[0]), null);
    assert.equal(store.verifySession(tokens[3]), null);
    assert.ok(store.verifySession(tokens[4]));
    assert.ok(store.verifySession(tokens[13]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('wrong guesses on the change-password form do not lock sign-in, and long passwords are refused', async () => {
  const s = await startServer();
  try {
    const token = (await s.login('admin', 'admin-password-1')).json.token;
    for (let i = 0; i < 6; i += 1) {
      const res = await s.call('PUT', '/v1/me/password', { key: token, body: { current: `wrong-${i}`, new: 'a-new-password-1' } });
      assert.ok([401, 429].includes(res.status));
    }
    assert.equal((await s.call('PUT', '/v1/me/password', { key: token, body: { current: 'admin-password-1', new: 'a-new-password-1' } })).status, 429);
    assert.equal((await s.login('admin', 'admin-password-1')).status, 200);
    assert.equal((await s.login('admin', 'admin-password-1' + 'x'.repeat(200))).status, 401);
  } finally {
    await s.close();
  }
});

test('a damaged users or keys file gives a clear refusal on changes, and sign-in keeps working', async () => {
  const s = await startServer();
  try {
    const token = (await s.login('admin', 'admin-password-1')).json.token;
    fs.writeFileSync(path.join(s.base, 'config', 'users.json'), '{ broken');
    fs.writeFileSync(path.join(s.base, 'config', 'keys.json'), JSON.stringify({ keys: [{ id: 'x', hash: 'y', access: 'root' }] }));
    assert.equal((await s.call('GET', '/v1/me', { key: token })).status, 200);
    assert.equal((await s.call('GET', '/v1/me')).status, 200);
    const user = await s.call('POST', '/v1/users', { body: { username: 'new', password: 'long-enough-pw', access: 'read' } });
    assert.equal(user.status, 503);
    assert.equal(user.json.error.code, 'settings_file_damaged');
    assert.equal((await s.call('POST', '/v1/keys', { body: { name: 'n', access: 'read' } })).status, 503);
    assert.equal((await s.login('admin', 'admin-password-1')).status, 200);
  } finally {
    await s.close();
  }
});
