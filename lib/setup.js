'use strict';

// First-run setup without a terminal.
//
// When the server starts as a background service there is nowhere to print
// a first password. Instead it writes a one-time setup code to a file only
// this user can read. `modelbrain-rag open` (and the installer) read that
// file and open the web page with the code in the address fragment, which
// browsers never send to a server or write to its log. The page then lets
// the person choose the first admin username and password.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FILE_NAME = 'setup-code';
const OPENER_PREFIX = 'open-setup-';
const MAX_WRONG_CODES = 20;
const CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest();
}

class Setup {
  constructor(dir) {
    this.file = path.join(dir, FILE_NAME);
    this.hash = null;
    this.wrong = 0;
  }

  get pending() {
    return this.hash !== null;
  }

  // Makes a new code and writes it where only this user can read it.
  begin() {
    const code = crypto.randomBytes(32).toString('base64url');
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${code}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.hash = sha256(code);
    this.wrong = 0;
  }

  // Takes the pending code out of use if `code` is it, so it works once
  // even when several requests arrive together. Returns a token to hand to
  // restore() if the account could not be made after all, or null when the
  // code is wrong. After too many wrong codes a new code replaces the old
  // one, so guessing never gets more than a few tries at any one code and
  // the person can always start again from the installer.
  take(code) {
    if (!this.pending || typeof code !== 'string') return null;
    const ok = CODE_PATTERN.test(code) && crypto.timingSafeEqual(sha256(code), this.hash);
    if (!ok) {
      this.wrong += 1;
      if (this.wrong >= MAX_WRONG_CODES) this.begin();
      return null;
    }
    const held = this.hash;
    this.hash = null;
    return held;
  }

  restore(held) {
    if (held && !this.pending) this.hash = held;
  }

  // Lets `modelbrain-rag open` check that the program answering on the port
  // is the one that wrote the code file, without showing the code.
  id() {
    return this.pending ? idFor(this.hash) : null;
  }

  finish() {
    this.hash = null;
    const dir = path.dirname(this.file);
    try {
      fs.unlinkSync(this.file);
    } catch {
      // Already gone.
    }
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith(OPENER_PREFIX)) fs.unlinkSync(path.join(dir, name));
      }
    } catch {
      // Nothing to tidy.
    }
  }
}

function idFor(hash) {
  return crypto.createHash('sha256').update(hash).update('modelbrain-rag setup id').digest('hex').slice(0, 32);
}

function idForCode(code) {
  return idFor(sha256(code));
}

// Writes a small page, readable only by this user, that sends the browser
// to the setup address. Opening this file instead of the address keeps the
// code out of the list of running programs.
function writeOpener(dir, url) {
  const file = path.join(dir, `${OPENER_PREFIX}${crypto.randomBytes(6).toString('hex')}.html`);
  const safe = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>ModelBrain RAG</title><meta http-equiv="refresh" content="0;url=${safe}"><p><a href="${safe}">Open ModelBrain RAG</a></p>\n`, { mode: 0o600 });
  return file;
}

// The pending code, for `modelbrain-rag open`. Null when there is none.
function readCode(dir) {
  try {
    const code = fs.readFileSync(path.join(dir, FILE_NAME), 'utf8').trim();
    return CODE_PATTERN.test(code) ? code : null;
  } catch {
    return null;
  }
}

module.exports = { Setup, readCode, idForCode, writeOpener, FILE_NAME, OPENER_PREFIX };
