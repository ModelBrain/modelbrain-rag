'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const config = require('../lib/config.js');
const { checkName } = require('../lib/documents.js');
const { candidatesForPlatform, parseToolResult } = require('../lib/engine.js');
const { matchConnector } = require('../lib/server.js');

const CLI = path.join(__dirname, '..', 'bin', 'modelbrain-rag.js');

test('the port and folder come from flags, then the environment, then the saved settings, then defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbrag-cfg-'));
  try {
    const env = { MODELBRAIN_RAG_CONFIG_DIR: dir };
    assert.equal(config.resolve({ env }).port, config.DEFAULT_PORT);
    config.saveSettings(dir, { port: 9001, docsDir: path.join(dir, 'saved') });
    assert.equal(config.resolve({ env }).port, 9001);
    assert.equal(config.resolve({ env }).docsDir, path.join(dir, 'saved'));
    assert.equal(config.resolve({ env: { ...env, MODELBRAIN_RAG_PORT: '9002' } }).port, 9002);
    assert.equal(config.resolve({ env: { ...env, MODELBRAIN_RAG_PORT: '9002' }, flags: { port: '9003' } }).port, 9003);
    assert.throws(() => config.resolve({ env, flags: { port: '0' } }), /port/);
    assert.throws(() => config.resolve({ env, flags: { port: 'abc' } }), /port/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the command line saves a port and manages keys', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbrag-cli-'));
  const env = { ...process.env, MODELBRAIN_RAG_CONFIG_DIR: dir, MODELBRAIN_RAG_DIR: path.join(dir, 'docs') };
  const run = (...args) => execFileSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
  try {
    assert.match(run('config', 'set', 'port', '9100'), /Saved/);
    assert.match(run('config', 'show'), /Port: 9100/);
    assert.throws(() => run('config', 'set', 'port', '70000'));
    const made = run('keys', 'create', '--name', 'app', '--access', 'admin');
    const key = /mbrag_[0-9a-f]{12}_[A-Za-z0-9_-]+/.exec(made)[0];
    const second = run('keys', 'create', '--name', 'reader', '--collections', 'a,b');
    const id = /id ([0-9a-f]{12})/.exec(second)[1];
    const listed = run('keys', 'list');
    assert.match(listed, /admin\s+app/);
    assert.match(listed, /collections=a,b/);
    assert.ok(!listed.includes(key));
    assert.match(run('keys', 'revoke', id), /Revoked/);
    assert.match(run('keys', 'list'), /REVOKED/);
    assert.match(run('keys', 'prune'), /Removed 1/);
    assert.match(run('status'), /Keys: 1 active/);

    const user = run('users', 'create', '--username', 'maria', '--access', 'admin');
    const password = /Password: (\S+)/.exec(user)[1];
    assert.ok(password.length >= 16);
    assert.match(run('users', 'create', '--username', 'sam', '--password', 'a-long-password', '--collections', 'a'), /Made user "sam" \(read\)/);
    assert.throws(() => run('users', 'create', '--username', 'maria', '--password', 'a-long-password'));
    assert.throws(() => run('users', 'create', '--username', 'x', '--password', 'short'));
    const users = run('users', 'list');
    assert.match(users, /maria\s+admin/);
    assert.match(users, /sam\s+read\s+collections=a/);
    assert.ok(!users.includes(password));
    assert.match(run('users', 'set-access', 'sam', '--access', 'write'), /write access/);
    assert.match(run('users', 'disable', 'sam'), /disabled/);
    assert.match(run('users', 'list'), /sam.*DISABLED/);
    assert.match(run('users', 'set-password', 'sam'), /Password: \S+/);
    assert.match(run('users', 'remove', 'sam'), /Removed/);
    assert.throws(() => run('users', 'remove', 'maria'));
    assert.match(run('status'), /Users: 1 active/);
    assert.match(run('--version'), /^\d+\.\d+\.\d+/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('names are checked the same way on every platform', () => {
  for (const good of ['notes.md', 'Q3 report (final).pdf', 'résumé.docx', 'a'.repeat(200)]) assert.equal(checkName(good, 'Document'), good.normalize('NFC'));
  for (const bad of ['', '.', '..', '.env', '~$lock.docx', 'a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a|b', 'tab\tname', 'nul', 'COM1.txt', 'end.', 'end ', 'a'.repeat(201), 5, null]) {
    assert.throws(() => checkName(bad, 'Document'), /name/, String(bad));
  }
});

test('the documents folder is matched to the deepest ModelBrain folder that contains it', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mbrag-match-')));
  try {
    const vault = path.join(base, 'vault');
    const docs = path.join(vault, 'team', 'docs');
    fs.mkdirSync(docs, { recursive: true });
    const connectors = [
      { id: 'outer', root: vault },
      { id: 'inner', root: path.join(vault, 'team') },
      { id: 'elsewhere', root: path.join(base, 'other') },
      { id: 'sibling', root: path.join(vault, 'team', 'docs-old') },
      { root: vault },
      null,
    ];
    assert.deepEqual(matchConnector(connectors, docs, 'linux'), { id: 'inner', prefix: 'docs', segments: ['docs'] });
    assert.deepEqual(matchConnector([{ id: 'outer', root: vault }], docs, 'linux'), { id: 'outer', prefix: 'team/docs', segments: ['team', 'docs'] });
    assert.deepEqual(matchConnector([{ id: 'exact', root: docs }], docs, 'linux'), { id: 'exact', prefix: '', segments: [] });
    assert.equal(matchConnector([{ id: 'elsewhere', root: path.join(base, 'other') }], docs, 'linux'), null);
    assert.equal(matchConnector([{ id: 'child', root: path.join(docs, 'sub') }], docs, 'linux'), null);
    assert.equal(matchConnector([], docs, 'linux'), null);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('ModelBrain is looked for in each platform\'s install folder', () => {
  assert.ok(candidatesForPlatform('darwin', {}, '/Users/x')[0].endsWith('ModelBrain.app/Contents/MacOS/mcp_server'));
  assert.equal(candidatesForPlatform('linux', {}, '/home/x')[0], path.join('/home/x', '.local', 'lib', 'modelbrain', 'mcp_server'));
  assert.ok(candidatesForPlatform('win32', { LOCALAPPDATA: 'C:\\L' }, 'C:\\U')[0].endsWith('mcp_server.exe'));
  assert.deepEqual(candidatesForPlatform('win32', {}, 'C:\\U'), []);
  assert.deepEqual(candidatesForPlatform('freebsd', {}, '/home/x'), []);
});

test('tool results are read from structured content, then text, and errors are raised', () => {
  assert.deepEqual(parseToolResult({ structuredContent: { a: 1 }, content: [{ type: 'text', text: '{"a":2}' }] }), { a: 1 });
  assert.deepEqual(parseToolResult({ content: [{ type: 'text', text: '{"a":2}' }] }), { a: 2 });
  assert.deepEqual(parseToolResult({ content: [{ type: 'text', text: 'plain' }] }), { text: 'plain' });
  assert.throws(() => parseToolResult({ isError: true, content: [{ type: 'text', text: 'no' }] }), /no/);
  assert.throws(() => parseToolResult(null), /empty/);
});
