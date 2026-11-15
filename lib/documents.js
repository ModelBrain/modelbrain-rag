'use strict';

// The documents folder: one folder on disk, one subfolder per collection.
// ModelBrain's own folder watcher indexes whatever is in it. This file only
// reads and writes files inside that folder; it never touches ModelBrain's
// data.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// File types accepted for upload. ModelBrain extracts text from all of them.
const UPLOAD_EXTENSIONS = [
  'md', 'markdown', 'txt', 'pdf', 'docx', 'pptx', 'xlsx',
  'csv', 'tsv', 'json', 'yaml', 'yml', 'toml', 'html', 'htm', 'xml',
];

// File types ModelBrain searches when they are put in the folder by hand.
// Used only to label files in listings.
const SEARCHABLE_EXTENSIONS = UPLOAD_EXTENSIONS.concat([
  'canvas', 'rs', 'py', 'js', 'jsx', 'ts', 'tsx', 'go', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs',
  'rb', 'php', 'swift', 'm', 'mm', 'scala', 'lua', 'pl', 'r', 'sh', 'bash', 'zsh', 'ps1', 'sql',
  'ini', 'cfg', 'conf', 'css', 'scss', 'log',
]);

// Folder and file names ModelBrain's folder watcher skips. A collection or
// document with one of these names would be stored but never searched, so
// it is refused with the reason.
const SKIPPED_FOLDER_NAMES = [
  'node_modules', 'target', 'dist', 'build', '__pycache__', 'vendor', 'logs', 'log', 'tmp', 'temp',
  'var', 'coverage', 'dist.noindex', 'bench-models', 'bench-results', '_to_delete', 'claude outputs',
];
const SKIPPED_FILE_NAMES = ['Cargo.lock', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'poetry.lock', 'Gemfile.lock'];

const TEMP_DIR = '.modelbrain-rag-tmp';
const MAX_NAME_LENGTH = 200;
const MAX_LISTED = 10000;
const MAX_DEPTH = 8;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;

class DocumentError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'DocumentError';
    this.status = status;
    this.code = code;
  }
}

// One path part (a collection or a document name) that is safe on macOS,
// Windows and Linux and cannot leave the folder it is joined to.
function checkName(name, what) {
  if (typeof name !== 'string') throw new DocumentError(400, 'invalid_name', `${what} name must be text.`);
  const value = name.normalize('NFC');
  const bad = (why) => new DocumentError(400, 'invalid_name', `${what} name ${why}.`);
  if (value.length === 0) throw bad('is empty');
  if (value.length > MAX_NAME_LENGTH) throw bad(`is longer than ${MAX_NAME_LENGTH} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f/\\:*?"<>|]/.test(value)) throw bad('contains a character that file names cannot hold');
  // Invisible and direction-changing characters can make one name look like another.
  if (/[\u00ad\u200b-\u200f\u202a-\u202e\u2028\u2029\u2060-\u206f\ufeff\ufff9-\ufffb]/.test(value)) throw bad('contains an invisible or direction-changing character');
  if (value === '.' || value === '..') throw bad('is not allowed');
  if (value.startsWith('.') || value.startsWith('~$')) throw bad('cannot start with a dot or ~$ (ModelBrain skips those files)');
  if (/[ .]$/.test(value) || /^ /.test(value)) throw bad('cannot start with a space or end with a space or a dot');
  if (WINDOWS_RESERVED.test(value.split('.')[0].trim())) throw bad('is reserved on Windows');
  return value;
}

function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

// Why ModelBrain would never search a file with this name, or null.
function skippedFileReason(name) {
  return SKIPPED_FILE_NAMES.includes(name) ? 'lock files are skipped' : null;
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

class Documents {
  constructor(root) {
    this.root = path.resolve(root);
  }

  ensureRoot() {
    fs.mkdirSync(this.root, { recursive: true });
  }

  // True when `dir` still is the plain folder `name` directly under the
  // documents folder, not a link to somewhere else.
  stillInside(dir, name) {
    try {
      return fs.realpathSync(dir) === path.join(fs.realpathSync(this.root), name);
    } catch {
      return false;
    }
  }

  // A real directory (not a link) directly under the root.
  collectionDir(collection, { create = false } = {}) {
    const name = checkName(collection, 'Collection');
    // Checked for existing folders too: a hand-made folder with one of these
    // names would take uploads that are never searched.
    if (create && SKIPPED_FOLDER_NAMES.includes(name.toLowerCase())) {
      throw new DocumentError(422, 'name_not_indexed', `ModelBrain never indexes a folder named "${name}". Pick another collection name.`);
    }
    const dir = path.join(this.root, name);
    let stat = null;
    try {
      stat = fs.lstatSync(dir);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (!stat) {
      if (!create) throw new DocumentError(404, 'collection_not_found', `There is no collection named "${name}".`);
      this.ensureRoot();
      const twin = fs.readdirSync(this.root).find((entry) => entry.normalize('NFC').toLowerCase() === name.toLowerCase());
      if (twin) {
        throw new DocumentError(409, 'collection_exists', `A collection named "${twin}" already exists. Names that differ only by upper and lower case are not allowed.`);
      }
      fs.mkdirSync(dir);
      return { name, dir, created: true };
    }
    if (!stat.isDirectory() || !this.stillInside(dir, name)) {
      throw new DocumentError(409, 'not_a_collection', `"${name}" exists in the documents folder but is not a plain folder.`);
    }
    return { name, dir, created: false };
  }

  // Collections, plus the names of folders the API cannot address (made by
  // hand with a name the API does not allow).
  listCollections() {
    let entries;
    try {
      entries = fs.readdirSync(this.root, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return { collections: [], skipped: [] };
      throw err;
    }
    const collections = [];
    const skipped = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      let ok = false;
      try {
        ok = checkName(entry.name, 'Collection') === entry.name && !SKIPPED_FOLDER_NAMES.includes(entry.name.toLowerCase());
      } catch {
        ok = false;
      }
      if (!ok) {
        skipped.push(entry.name);
        continue;
      }
      const listing = this.listDocuments(entry.name);
      collections.push({ name: entry.name, documents: listing.documents.length, truncated: listing.truncated });
    }
    collections.sort((a, b) => a.name.localeCompare(b.name));
    skipped.sort((a, b) => a.localeCompare(b));
    return { collections, skipped };
  }

  createCollection(collection) {
    const { name, created } = this.collectionDir(collection, { create: true });
    return { name, created };
  }

  // Removes a collection only when it holds no files, so one call can never
  // delete a folder of documents.
  deleteCollection(collection) {
    const { name, dir } = this.collectionDir(collection);
    const left = fs.readdirSync(dir).filter((entry) => entry !== '.DS_Store');
    if (left.length > 0) {
      throw new DocumentError(409, 'collection_not_empty', `Collection "${name}" still holds files. Delete them first.`);
    }
    fs.rmSync(path.join(dir, '.DS_Store'), { force: true });
    fs.rmdirSync(dir);
    return { name };
  }

  listDocuments(collection) {
    const { name, dir } = this.collectionDir(collection);
    const documents = [];
    let truncated = false;
    const walk = (current, prefix, depth) => {
      let entries;
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (truncated) return;
        if (entry.name.startsWith('.') || entry.name.startsWith('~$')) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (depth < MAX_DEPTH && !SKIPPED_FOLDER_NAMES.includes(entry.name.toLowerCase())) walk(path.join(current, entry.name), rel, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        if (documents.length >= MAX_LISTED) {
          truncated = true;
          return;
        }
        let stat;
        try {
          stat = fs.statSync(path.join(current, entry.name));
        } catch {
          continue;
        }
        documents.push({
          name: rel,
          bytes: stat.size,
          modified: new Date(stat.mtimeMs).toISOString(),
          searchable: SEARCHABLE_EXTENSIONS.includes(extensionOf(entry.name)) && skippedFileReason(entry.name) === null,
        });
      }
    };
    walk(dir, '', 0);
    return { collection: name, documents, truncated };
  }

  // The hidden folder uploads are written to first. It must be a real
  // folder of ours, not a link someone planted.
  tempDir() {
    const dir = path.join(this.root, TEMP_DIR);
    let stat = null;
    try {
      stat = fs.lstatSync(dir);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (!stat) {
      fs.mkdirSync(dir, { mode: 0o700 });
    } else if (!stat.isDirectory() || !this.stillInside(dir, TEMP_DIR)) {
      throw new DocumentError(409, 'temp_folder_blocked', `"${TEMP_DIR}" in the documents folder is not a plain folder. Remove it and try again.`);
    }
    return dir;
  }

  // Writes one document. The bytes go to a hidden temp folder first and are
  // renamed into place, so ModelBrain never indexes a half-written file.
  putDocument(collection, document, bytes) {
    const docName = checkName(document, 'Document');
    const ext = extensionOf(docName);
    if (!UPLOAD_EXTENSIONS.includes(ext)) {
      throw new DocumentError(
        415,
        'unsupported_type',
        `"${ext || 'no extension'}" files cannot be uploaded. Supported: ${UPLOAD_EXTENSIONS.join(', ')}.`
      );
    }
    const skipped = skippedFileReason(docName);
    if (skipped) {
      throw new DocumentError(422, 'name_not_indexed', `ModelBrain would never index "${docName}": ${skipped}. Rename the file.`);
    }
    const { name, dir } = this.collectionDir(collection, { create: true });
    const target = path.join(dir, docName);
    let replaced = false;
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile()) {
        throw new DocumentError(409, 'not_a_document', `"${docName}" exists in "${name}" but is not a plain file.`);
      }
      replaced = true;
    } catch (err) {
      if (err instanceof DocumentError) throw err;
      if (err.code !== 'ENOENT') throw err;
    }
    const temp = path.join(this.tempDir(), crypto.randomBytes(12).toString('hex'));
    try {
      fs.writeFileSync(temp, bytes, { flag: 'wx' });
      // Check again right before the move: the collection folder must still
      // be the plain folder it was a moment ago.
      if (!this.stillInside(dir, name)) {
        throw new DocumentError(409, 'not_a_collection', `"${name}" is no longer a plain folder in the documents folder.`);
      }
      for (let attempt = 0; ; attempt += 1) {
        try {
          fs.renameSync(temp, target);
          break;
        } catch (err) {
          // Windows refuses for a moment while another program reads the file.
          if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
          sleepMs(60);
        }
      }
    } catch (err) {
      fs.rmSync(temp, { force: true });
      if (err.code === 'EBUSY') throw new DocumentError(423, 'file_in_use', `"${docName}" is in use by another program. Try again in a moment.`);
      throw err;
    }
    return { collection: name, document: docName, bytes: bytes.length, replaced };
  }

  // Where one document is on disk, after the same checks as a delete: the
  // name is a plain file name, the file is a real file (not a link), and
  // the collection folder is still inside the documents folder.
  findDocument(collection, document) {
    const docName = checkName(document, 'Document');
    const { name, dir } = this.collectionDir(collection);
    const target = path.join(dir, docName);
    let stat;
    try {
      stat = fs.lstatSync(target);
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new DocumentError(404, 'document_not_found', `There is no document named "${docName}" in "${name}".`);
      }
      throw err;
    }
    if (!stat.isFile() || !this.stillInside(dir, name)) {
      throw new DocumentError(409, 'not_a_document', `"${docName}" in "${name}" is not a plain file.`);
    }
    return { collection: name, document: docName, file: target, bytes: stat.size };
  }

  deleteDocument(collection, document) {
    const docName = checkName(document, 'Document');
    const { name, dir } = this.collectionDir(collection);
    const target = path.join(dir, docName);
    let stat;
    try {
      stat = fs.lstatSync(target);
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new DocumentError(404, 'document_not_found', `There is no document named "${docName}" in "${name}".`);
      }
      throw err;
    }
    if (!stat.isFile() || !this.stillInside(dir, name)) {
      throw new DocumentError(409, 'not_a_document', `"${docName}" in "${name}" is not a plain file.`);
    }
    try {
      fs.unlinkSync(target);
    } catch (err) {
      if (err.code === 'EBUSY') throw new DocumentError(423, 'file_in_use', `"${docName}" is in use by another program. Try again in a moment.`);
      throw err;
    }
    return { collection: name, document: docName };
  }
}

module.exports = {
  Documents, DocumentError, checkName, extensionOf, skippedFileReason,
  UPLOAD_EXTENSIONS, SEARCHABLE_EXTENSIONS, SKIPPED_FOLDER_NAMES, TEMP_DIR,
};
