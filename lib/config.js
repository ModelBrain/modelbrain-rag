'use strict';

// Where this program keeps its own settings, keys and users, and its
// defaults.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_PORT = 8757;
const DEFAULT_MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

function configDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.MODELBRAIN_RAG_CONFIG_DIR) return path.resolve(env.MODELBRAIN_RAG_CONFIG_DIR);
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'ModelBrain RAG');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'ModelBrain RAG');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'modelbrain-rag');
}

function defaultDocsDir(home = os.homedir()) {
  return path.join(home, 'ModelBrain RAG');
}

function settingsFile(dir) {
  return path.join(dir, 'settings.json');
}

function loadSettings(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile(dir), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`Could not read ${settingsFile(dir)}: ${err.message}`);
  }
}

function saveSettings(dir, settings) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = settingsFile(dir);
  const temp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

// A port as a whole number or a string of digits. Ports below 1024 need
// special rights to open, so they are refused.
function checkPort(value) {
  const ok = (typeof value === 'number' && Number.isInteger(value)) || (typeof value === 'string' && /^[0-9]{1,5}$/.test(value));
  const port = ok ? Number(value) : NaN;
  if (!ok || port < 1024 || port > 65535) throw new Error('The port must be a whole number from 1024 to 65535.');
  return port;
}

// The vaults and partitions an administrator has shared, by id.
function checkShared(value) {
  const out = { vaults: [], partitions: [] };
  if (value === undefined || value === null) return out;
  const okList = (list) => Array.isArray(list) && list.length <= 500 && list.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 120);
  if (typeof value !== 'object' || Array.isArray(value) || (value.vaults !== undefined && !okList(value.vaults)) || (value.partitions !== undefined && !okList(value.partitions))) {
    throw new Error('"shared" in settings.json must hold lists of vault and partition ids.');
  }
  out.vaults = [...new Set(value.vaults || [])];
  out.partitions = [...new Set(value.partitions || [])];
  return out;
}

// Web origins exactly as a browser sends them: scheme, host and port.
function checkOrigins(value) {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new Error('Allowed web origins must be a list of addresses such as http://localhost:3000.');
  }
  return value.map((entry) => {
    let origin;
    try {
      origin = new URL(entry).origin;
    } catch {
      origin = 'null';
    }
    if (origin === 'null') throw new Error(`"${entry}" is not a web origin. Use a form such as http://localhost:3000.`);
    return origin;
  });
}

// Settings in order of priority: command line, environment, settings file,
// defaults.
function resolve({ flags = {}, env = process.env } = {}) {
  const dir = configDir(env);
  const saved = loadSettings(dir);
  const port = checkPort(flags.port || env.MODELBRAIN_RAG_PORT || saved.port || DEFAULT_PORT);
  const docsDir = path.resolve(String(flags.docsDir || env.MODELBRAIN_RAG_DIR || saved.docsDir || defaultDocsDir()));
  const allowOrigins = checkOrigins(flags.allowOrigins || saved.allowOrigins || []);
  let maxUploadBytes = DEFAULT_MAX_UPLOAD_BYTES;
  if (saved.maxUploadBytes !== undefined) {
    if (!Number.isInteger(saved.maxUploadBytes) || saved.maxUploadBytes < 1) {
      throw new Error('maxUploadBytes in settings.json must be a whole number of bytes.');
    }
    maxUploadBytes = saved.maxUploadBytes;
  }
  return {
    dir,
    port,
    docsDir,
    allowOrigins,
    maxUploadBytes,
    shared: checkShared(saved.shared),
    keysFile: path.join(dir, 'keys.json'),
    usersFile: path.join(dir, 'users.json'),
  };
}

module.exports = { resolve, configDir, defaultDocsDir, loadSettings, saveSettings, checkPort, checkOrigins, checkShared, DEFAULT_PORT, DEFAULT_MAX_UPLOAD_BYTES };
