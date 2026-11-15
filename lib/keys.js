'use strict';

// API keys, for apps and scripts.
//
// A key looks like `mbrag_<id>_<secret>`. Only a SHA-256 hash of the whole
// key is kept on disk, so the key itself is shown once, when it is made, and
// cannot be read back later. Each key has a name, an access level and,
// optionally, a list of collections it is limited to.
//
// Access levels:
//   read   search, and list collections and documents
//   write  read, plus add and remove documents and collections
//   admin  write, plus manage keys, users and settings

const crypto = require('node:crypto');
const { checkName } = require('./documents.js');
const { JsonFile } = require('./jsonfile.js');

const ACCESS_LEVELS = ['read', 'write', 'admin'];
const MAX_KEYS = 500;
const LAST_USED_FLUSH_MS = 60000;
const KEY_PATTERN = /^mbrag_([0-9a-f]{12})_[A-Za-z0-9_-]{43}$/;

class KeyError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'KeyError';
    this.status = status;
    this.code = code;
  }
}

function hashKey(key) {
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
}

function rank(access) {
  return ACCESS_LEVELS.indexOf(access);
}

// A display name: 1 to 100 characters, no control characters.
function checkLabel(name, what) {
  // eslint-disable-next-line no-control-regex
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 100 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) {
    throw new KeyError(400, 'invalid_name', `${what} needs a name of 1 to 100 characters with no control characters.`);
  }
  return name.trim();
}

function checkAccess(access) {
  if (!ACCESS_LEVELS.includes(access)) {
    throw new KeyError(400, 'invalid_access', `Access must be one of: ${ACCESS_LEVELS.join(', ')}.`);
  }
  return access;
}

// A grant for a shared vault or partition: "vault:<id>" or "partition:<id>".
// eslint-disable-next-line no-control-regex
const SOURCE_GRANT = /^(vault|partition):[^\u0000-\u001f\u007f-\u009f/\\]{1,120}$/;

// What a key or user is limited to: a list of collection names and grants
// for shared vaults ("vault:<id>") and partitions ("partition:<id>"), or
// null for everything.
function checkCollections(collections, access) {
  if (collections === null || collections === undefined) return null;
  if (!Array.isArray(collections) || collections.length === 0 || collections.length > 100) {
    throw new KeyError(400, 'invalid_collections', 'The limit must be a list of 1 to 100 collection names, "vault:<id>" or "partition:<id>" entries, or left out.');
  }
  if (access === 'admin') {
    throw new KeyError(400, 'invalid_collections', 'Admin access cannot be limited.');
  }
  try {
    return [...new Set(collections.map((c) => (typeof c === 'string' && SOURCE_GRANT.test(c) ? c : checkName(c, 'Collection'))))];
  } catch (err) {
    throw new KeyError(400, 'invalid_collections', err.message);
  }
}

// Whether a list read from disk is a usable limit.
function validLimit(collections) {
  return collections === null || collections === undefined || (Array.isArray(collections) && collections.every((c) => typeof c === 'string'));
}

class KeyStore {
  constructor(file) {
    this.store = new JsonFile(file, {
      empty: () => ({ keys: [] }),
      check: (parsed) => {
        if (!parsed || !Array.isArray(parsed.keys) || !parsed.keys.every((k) => k && typeof k.id === 'string' && typeof k.hash === 'string' && ACCESS_LEVELS.includes(k.access) && validLimit(k.collections))) {
          throw new Error('not a key file');
        }
      },
    });
    this.used = new Map();
    this.lastFlush = Date.now();
    this.store.load({ strict: true });
  }

  get keys() {
    return this.store.load().keys;
  }

  hasActiveAdmin() {
    return this.keys.some((k) => k.access === 'admin' && !k.revoked);
  }

  // Makes a key and returns it. This is the only time the key is available.
  create({ name, access = 'read', collections = null } = {}) {
    const label = checkLabel(name, 'A key');
    checkAccess(access);
    const limited = checkCollections(collections, access);
    const keys = this.store.load({ force: true, strict: true }).keys;
    if (keys.length >= MAX_KEYS) {
      throw new KeyError(409, 'too_many_keys', `There are already ${MAX_KEYS} keys. Remove revoked ones first.`);
    }
    const id = crypto.randomBytes(6).toString('hex');
    const key = `mbrag_${id}_${crypto.randomBytes(32).toString('base64url')}`;
    const record = {
      id,
      name: label,
      access,
      collections: limited,
      hash: hashKey(key),
      created: new Date().toISOString(),
      last_used: null,
      revoked: null,
    };
    keys.push(record);
    this.store.save();
    return { key, record: publicView(record) };
  }

  list() {
    return this.keys.map((k) => publicView({ ...k, last_used: this.used.get(k.id) || k.last_used }));
  }

  revoke(id) {
    const keys = this.store.load({ force: true, strict: true }).keys;
    const record = keys.find((k) => k.id === id);
    if (!record) throw new KeyError(404, 'key_not_found', `There is no key with id "${id}".`);
    if (record.revoked) return publicView(record);
    const otherAdmins = keys.some((k) => k.id !== id && k.access === 'admin' && !k.revoked);
    if (record.access === 'admin' && !otherAdmins) {
      throw new KeyError(409, 'last_admin_key', 'This is the only admin key. Make another admin key before revoking it.');
    }
    record.revoked = new Date().toISOString();
    this.store.save();
    return publicView(record);
  }

  // Deletes revoked keys from the file.
  prune() {
    const data = this.store.load({ force: true, strict: true });
    const before = data.keys.length;
    data.keys = data.keys.filter((k) => !k.revoked);
    if (data.keys.length !== before) this.store.save();
    return before - data.keys.length;
  }

  // The record for a presented key, or null. Compares hashes in constant time.
  verify(presented) {
    if (typeof presented !== 'string' || presented.length > 200) return null;
    const match = KEY_PATTERN.exec(presented);
    if (!match) return null;
    const record = this.keys.find((k) => k.id === match[1]);
    const wanted = Buffer.from(record ? record.hash : hashKey('no such key'), 'hex');
    const got = Buffer.from(hashKey(presented), 'hex');
    const same = wanted.length === got.length && crypto.timingSafeEqual(wanted, got);
    if (!record || !same || record.revoked) return null;
    this.used.set(record.id, new Date().toISOString());
    if (Date.now() - this.lastFlush > LAST_USED_FLUSH_MS) this.flush();
    return { kind: 'key', id: record.id, name: record.name, access: record.access, collections: record.collections };
  }

  // Writes last-used times. It always starts from what is on disk now, so a
  // key revoked by another process stays revoked. A failure here must never
  // fail a request.
  flush() {
    this.lastFlush = Date.now();
    if (this.used.size === 0) return;
    try {
      const keys = this.store.load({ force: true, strict: true }).keys;
      let changed = false;
      for (const k of keys) {
        const used = this.used.get(k.id);
        if (used && (!k.last_used || used > k.last_used)) {
          k.last_used = used;
          changed = true;
        }
      }
      if (changed) this.store.save();
      this.used.clear();
    } catch {
      // Try again at the next flush.
    }
  }
}

function publicView(record) {
  return {
    id: record.id,
    name: record.name,
    access: record.access,
    collections: record.collections,
    created: record.created,
    last_used: record.last_used,
    revoked: record.revoked,
  };
}

function allows(who, needed) {
  return rank(who.access) >= rank(needed);
}

// Whether this key or user may touch this collection.
function allowsCollection(who, collection) {
  if (!who.collections) return true;
  const wanted = String(collection).normalize('NFC').toLowerCase();
  return who.collections.some((c) => !SOURCE_GRANT.test(c) && c.toLowerCase() === wanted);
}

// Whether this key or user may search this shared vault or partition.
function allowsSource(who, kind, id) {
  if (!who.collections) return true;
  return who.collections.includes(`${kind}:${id}`);
}

module.exports = { KeyStore, KeyError, ACCESS_LEVELS, allows, allowsCollection, allowsSource, hashKey, checkLabel, checkAccess, checkCollections, validLimit, SOURCE_GRANT };
