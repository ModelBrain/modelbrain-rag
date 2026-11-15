'use strict';

// User accounts for the web page: a username and password, an access level
// and, optionally, a list of what the user is limited to.
//
// Passwords are stored only as scrypt hashes with a per-user salt. Signing
// in gives a session token that lives in this server's memory, so every
// session ends when the server stops.

const crypto = require('node:crypto');
const { JsonFile } = require('./jsonfile.js');
const { KeyError, ACCESS_LEVELS, checkAccess, checkCollections, validLimit } = require('./keys.js');

const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 200;
const MAX_USERS = 200;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESSION_IDLE_MS = 8 * 60 * 60 * 1000;
const SESSION_MAX_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 1000;
const MAX_SESSIONS_PER_USER = 10;
const FREE_ATTEMPTS = 5;
const LOCK_BASE_MS = 30 * 1000;
const LOCK_MAX_MS = 15 * 60 * 1000;
const MAX_TRACKED_NAMES = 5000;
// Password checks waiting or running at once. More than this are refused,
// so a flood of sign-in attempts cannot tie the server up.
const MAX_PASSWORD_CHECKS = 16;
const SESSION_PATTERN = /^mbrags_[A-Za-z0-9_-]{43}$/;
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password.normalize('NFKC'), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function checkUsername(username) {
  if (typeof username !== 'string' || !USERNAME_PATTERN.test(username)) {
    throw new KeyError(400, 'invalid_username', 'A username is 1 to 64 letters, digits, dots, dashes, underscores or @, starting with a letter or digit.');
  }
  return username;
}

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new KeyError(400, 'invalid_password', `A password needs ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters.`);
  }
  return password;
}

function generatePassword() {
  return crypto.randomBytes(15).toString('base64url');
}

function publicUser(user) {
  return {
    username: user.username,
    access: user.access,
    collections: user.collections,
    disabled: Boolean(user.disabled),
    created: user.created,
    last_login: user.last_login,
  };
}

class UserStore {
  constructor(file, { now = () => Date.now() } = {}) {
    this.store = new JsonFile(file, {
      empty: () => ({ users: [] }),
      check: (parsed) => {
        const ok = (u) => u && typeof u.username === 'string' && typeof u.hash === 'string' && typeof u.salt === 'string' && ACCESS_LEVELS.includes(u.access) && validLimit(u.collections);
        if (!parsed || !Array.isArray(parsed.users) || !parsed.users.every(ok)) throw new Error('not a user file');
      },
    });
    this.now = now;
    this.sessions = new Map();
    this.failures = new Map();
    this.queues = new Map();
    this.checking = 0;
    this.store.load({ strict: true });
  }

  get users() {
    return this.store.load().users;
  }

  find(users, username) {
    const wanted = String(username).toLowerCase();
    return users.find((u) => u.username.toLowerCase() === wanted) || null;
  }

  hasActiveAdmin() {
    return this.users.some((u) => u.access === 'admin' && !u.disabled);
  }

  list() {
    return this.users.map(publicUser);
  }

  async create({ username, password, access = 'read', collections = null } = {}) {
    checkUsername(username);
    checkPassword(password);
    checkAccess(access);
    const limited = checkCollections(collections, access);
    const salt = crypto.randomBytes(16);
    const hash = await scrypt(password, salt);
    const users = this.store.load({ force: true, strict: true }).users;
    if (this.find(users, username)) throw new KeyError(409, 'user_exists', `There is already a user named "${username}".`);
    if (users.length >= MAX_USERS) throw new KeyError(409, 'too_many_users', `There are already ${MAX_USERS} users.`);
    const user = {
      // A random id, so a session can never carry over to a later account
      // that happens to reuse the same username.
      uid: crypto.randomBytes(12).toString('hex'),
      username,
      access,
      collections: limited,
      salt: salt.toString('hex'),
      hash: hash.toString('hex'),
      version: 1,
      disabled: false,
      created: new Date(this.now()).toISOString(),
      last_login: null,
    };
    users.push(user);
    this.store.save();
    this.endSessions(username);
    return publicUser(user);
  }

  // Changes a user's access, limits, disabled state or password. Refuses a
  // change that would leave no admin who can sign in.
  async update(username, changes) {
    const next = {};
    if (changes.access !== undefined) next.access = checkAccess(changes.access);
    if (changes.disabled !== undefined) {
      if (typeof changes.disabled !== 'boolean') throw new KeyError(400, 'invalid_disabled', '"disabled" must be true or false.');
      next.disabled = changes.disabled;
    }
    let secret = null;
    if (changes.password !== undefined) {
      checkPassword(changes.password);
      const salt = crypto.randomBytes(16);
      secret = { salt: salt.toString('hex'), hash: (await scrypt(changes.password, salt)).toString('hex') };
    }
    const users = this.store.load({ force: true, strict: true }).users;
    const user = this.find(users, username);
    if (!user) throw new KeyError(404, 'user_not_found', `There is no user named "${username}".`);
    const access = next.access || user.access;
    const collections = changes.collections !== undefined ? checkCollections(changes.collections, access) : access === 'admin' ? null : user.collections;
    const disabled = next.disabled !== undefined ? next.disabled : Boolean(user.disabled);
    const wasAdmin = user.access === 'admin' && !user.disabled;
    const staysAdmin = access === 'admin' && !disabled;
    if (wasAdmin && !staysAdmin && !users.some((u) => u !== user && u.access === 'admin' && !u.disabled)) {
      throw new KeyError(409, 'last_admin_user', 'This is the only admin user. Make another admin user first.');
    }
    const changed = access !== user.access || disabled !== Boolean(user.disabled) || JSON.stringify(collections) !== JSON.stringify(user.collections) || secret;
    user.access = access;
    user.collections = collections;
    user.disabled = disabled;
    if (secret) {
      user.salt = secret.salt;
      user.hash = secret.hash;
    }
    if (changed) user.version = (user.version || 1) + 1;
    this.store.save();
    if (changed) this.endSessions(user.username);
    if (secret) this.failures.delete(user.username.toLowerCase());
    return publicUser(user);
  }

  remove(username) {
    const data = this.store.load({ force: true, strict: true });
    const user = this.find(data.users, username);
    if (!user) throw new KeyError(404, 'user_not_found', `There is no user named "${username}".`);
    if (user.access === 'admin' && !user.disabled && !data.users.some((u) => u !== user && u.access === 'admin' && !u.disabled)) {
      throw new KeyError(409, 'last_admin_user', 'This is the only admin user. Make another admin user first.');
    }
    data.users = data.users.filter((u) => u !== user);
    this.store.save();
    this.endSessions(user.username);
    return publicUser(user);
  }

  // Ends every session for a username.
  endSessions(username) {
    const wanted = String(username).toLowerCase();
    for (const [id, session] of this.sessions) {
      if (session.username.toLowerCase() === wanted) this.sessions.delete(id);
    }
  }

  lockedFor(bucket) {
    const entry = this.failures.get(bucket);
    if (!entry || entry.until <= this.now()) return 0;
    return entry.until - this.now();
  }

  // Records a wrong password. When the table is full, entries that are not
  // currently locked are dropped; a live lock is never dropped.
  noteFailure(bucket, real) {
    if (!this.failures.has(bucket) && this.failures.size >= MAX_TRACKED_NAMES) {
      const now = this.now();
      for (const [name, entry] of this.failures) {
        if (entry.until <= now) this.failures.delete(name);
      }
      // Still full of live locks: only real usernames are worth the room.
      if (this.failures.size >= MAX_TRACKED_NAMES && !real) return;
    }
    const entry = this.failures.get(bucket) || { count: 0, until: 0 };
    entry.count += 1;
    if (entry.count >= FREE_ATTEMPTS) {
      entry.until = this.now() + Math.min(LOCK_MAX_MS, LOCK_BASE_MS * 2 ** Math.min(entry.count - FREE_ATTEMPTS, 10));
    }
    this.failures.set(bucket, entry);
  }

  // Runs password checks for one name one at a time, so the lock is
  // counted before the next guess is tried, and caps how many checks may
  // wait at once across all names.
  async oneAtATime(bucket, task) {
    if (this.checking >= MAX_PASSWORD_CHECKS) {
      throw new KeyError(429, 'too_many_attempts', 'Too many sign-in attempts at once. Try again in a moment.');
    }
    this.checking += 1;
    const before = this.queues.get(bucket) || Promise.resolve();
    const mine = before.then(task, task);
    const tail = mine.catch(() => {});
    this.queues.set(bucket, tail);
    try {
      return await mine;
    } finally {
      this.checking -= 1;
      if (this.queues.get(bucket) === tail) this.queues.delete(bucket);
    }
  }

  // Checks a username and password. The same work is done whether or not
  // the user exists, so the time taken does not reveal which it was.
  // `purpose` keeps wrong guesses on the change-password form from locking
  // sign-in, and the other way round.
  async checkPassword(username, password, purpose = 'login') {
    const name = String(username || '').toLowerCase().slice(0, 64);
    const bucket = `${purpose}:${name}`;
    return this.oneAtATime(bucket, async () => {
      const wait = this.lockedFor(bucket);
      if (wait > 0) {
        throw new KeyError(429, 'too_many_attempts', `Too many wrong passwords. Try again in ${Math.ceil(wait / 1000)} seconds.`);
      }
      const user = typeof username === 'string' ? this.find(this.users, username) : null;
      const usable = typeof password === 'string' && password.length <= MAX_PASSWORD_LENGTH;
      const salt = Buffer.from(user ? user.salt : '00'.repeat(16), 'hex');
      const wanted = Buffer.from(user ? user.hash : '00'.repeat(SCRYPT.keylen), 'hex');
      const got = await scrypt(usable ? password : '', salt);
      const ok = Boolean(user) && usable && wanted.length === got.length && crypto.timingSafeEqual(wanted, got) && !user.disabled;
      if (!ok) {
        this.noteFailure(bucket, Boolean(user));
        throw new KeyError(401, 'invalid_login', 'That username and password were not accepted.');
      }
      this.failures.delete(bucket);
      return user;
    });
  }

  // Signs in and returns a session token.
  async login(username, password) {
    const user = await this.checkPassword(username, password, 'login');
    return this.startSession(user);
  }

  startSession(user) {
    const now = this.now();
    this.sweep(now);
    // One user cannot use up every slot: their oldest session gives way.
    const own = [...this.sessions].filter(([, s]) => s.uid === user.uid).sort((a, b) => a[1].started - b[1].started);
    while (own.length >= MAX_SESSIONS_PER_USER) this.sessions.delete(own.shift()[0]);
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new KeyError(503, 'too_many_sessions', 'Too many people are signed in. Try again later.');
    }
    const token = `mbrags_${crypto.randomBytes(32).toString('base64url')}`;
    this.sessions.set(sha256(token), {
      uid: user.uid,
      username: user.username,
      version: user.version || 1,
      started: now,
      seen: now,
    });
    try {
      const fresh = this.find(this.store.load({ force: true, strict: true }).users, user.username);
      if (fresh && fresh.uid === user.uid) {
        fresh.last_login = new Date(now).toISOString();
        this.store.save();
      }
    } catch {
      // The sign-in still stands if the time could not be recorded.
    }
    return { token, expires: new Date(now + SESSION_IDLE_MS).toISOString(), user: publicUser(user) };
  }

  sweep(now) {
    for (const [id, session] of this.sessions) {
      if (now - session.seen > SESSION_IDLE_MS || now - session.started > SESSION_MAX_MS) this.sessions.delete(id);
    }
  }

  // The signed-in user for a session token, or null. A user who was
  // disabled, removed, replaced or changed since signing in is signed out.
  verifySession(token) {
    if (typeof token !== 'string' || !SESSION_PATTERN.test(token)) return null;
    const id = sha256(token);
    const session = this.sessions.get(id);
    if (!session) return null;
    const now = this.now();
    const user = this.find(this.users, session.username);
    if (
      now - session.seen > SESSION_IDLE_MS ||
      now - session.started > SESSION_MAX_MS ||
      !user ||
      user.uid !== session.uid ||
      user.disabled ||
      (user.version || 1) !== session.version
    ) {
      this.sessions.delete(id);
      return null;
    }
    session.seen = now;
    return { kind: 'user', id: user.uid, name: user.username, access: user.access, collections: user.collections };
  }

  logout(token) {
    if (typeof token !== 'string') return false;
    return this.sessions.delete(sha256(token));
  }
}

module.exports = { UserStore, checkUsername, checkPassword, generatePassword, SESSION_PATTERN, MIN_PASSWORD_LENGTH };
