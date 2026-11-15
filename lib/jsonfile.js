'use strict';

// A small JSON file shared between the running server and the command line.
// Reads notice a change made by another process; writes are atomic and the
// file is readable by the owner only.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// The file exists but cannot be used. The server answers 503 for this.
class StoreFileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StoreFileError';
    this.status = 503;
    this.code = 'settings_file_damaged';
  }
}

class JsonFile {
  // `check(parsed)` throws when the file's contents are not what is expected.
  constructor(file, { empty, check }) {
    this.file = file;
    this.empty = empty;
    this.check = check;
    this.signature = null;
    this.data = empty();
    this.loadError = null;
  }

  // The file is small, so it is read each time and compared by content.
  // That cannot miss a change, whatever the clock or the file system does.
  static signatureOf(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
  }

  // Loads the file when it changed. A file that cannot be read or parsed
  // keeps the last good contents in memory and records the problem; with
  // `strict` it throws instead (used by the command line and at start).
  load({ force = false, strict = false } = {}) {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.data = this.empty();
        this.signature = null;
        this.loadError = null;
        return this.data;
      }
      this.loadError = err.message;
      if (strict) throw new StoreFileError(`Could not read ${this.file}: ${err.message}`);
      return this.data;
    }
    const signature = JsonFile.signatureOf(text);
    if (!force && signature === this.signature && !this.loadError) return this.data;
    try {
      const parsed = JSON.parse(text);
      this.check(parsed);
      this.data = parsed;
      this.signature = signature;
      this.loadError = null;
    } catch (err) {
      this.loadError = err.message;
      if (strict) throw new StoreFileError(`${this.file} is damaged: ${err.message}. Fix or remove it.`);
    }
    return this.data;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    const text = JSON.stringify(this.data, null, 2) + '\n';
    try {
      fs.writeFileSync(temp, text, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temp, this.file);
    } catch (err) {
      fs.rmSync(temp, { force: true });
      throw err;
    }
    this.signature = JsonFile.signatureOf(text);
    this.loadError = null;
  }
}

module.exports = { JsonFile, StoreFileError };
