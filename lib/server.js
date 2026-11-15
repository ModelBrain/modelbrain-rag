'use strict';

// The HTTP API and the web page. The server listens on this computer only
// (127.0.0.1). Every /v1 route except sign-in needs an API key (for apps)
// or a signed-in session (for the web page).

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const configStore = require('./config.js');
const { DocumentError, checkName, SKIPPED_FOLDER_NAMES } = require('./documents.js');
const { EngineError, DOWNLOAD_URL } = require('./engine.js');
const { KeyError, allows, allowsCollection, allowsSource } = require('./keys.js');
const { SESSION_PATTERN } = require('./users.js');

const JSON_BODY_LIMIT = 1024 * 1024;
const SMALL_BODY_LIMIT = 16 * 1024;
const CONNECTION_FRESH_MS = 30000;
const CONNECTION_RETRY_MS = 5000;
const MAX_QUERY_LENGTH = 2000;
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const PARTITIONS_FRESH_MS = 30000;

const UI_DIR = path.join(__dirname, 'ui');
const UI_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/ui/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/ui/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/ui/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};
// The page may load only its own files and talk only to this server.
const UI_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function realpathOrSelf(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// Finds which ModelBrain folder connection covers the documents folder.
// Returns the connection's id and the documents folder's path inside it.
function matchConnector(connectors, docsDir, platform = process.platform) {
  const fold = (s) => (platform === 'darwin' || platform === 'win32' ? s.toLowerCase() : s);
  const realTarget = realpathOrSelf(docsDir);
  let best = null;
  for (const connector of connectors) {
    if (!connector || typeof connector.id !== 'string' || typeof connector.root !== 'string') continue;
    const realRoot = realpathOrSelf(connector.root);
    const rel = path.relative(fold(realRoot), fold(realTarget));
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue;
    if (!best || realRoot.length > best.rootLength) {
      // Take the folder names from the real path so their case is kept.
      const depth = rel === '' ? 0 : rel.split(path.sep).length;
      const parts = realTarget.split(path.sep).filter(Boolean);
      const segments = depth === 0 ? [] : parts.slice(parts.length - depth);
      best = { id: connector.id, segments, rootLength: realRoot.length };
    }
  }
  return best ? { id: best.id, prefix: best.segments.join('/'), segments: best.segments } : null;
}

// Splits a hit's path into collection and document, given how many folder
// levels the documents folder sits below the connection's root.
function splitSource(uri, prefixSegments) {
  const parts = uri.split('/');
  const n = prefixSegments.length;
  const underPrefix = parts.length > n && prefixSegments.every((seg, i) => parts[i].toLowerCase() === seg.toLowerCase());
  const inside = underPrefix ? parts.slice(n) : parts;
  if (inside.length <= 1) return { collection: null, document: inside.join('/') };
  return { collection: inside[0], document: inside.slice(1).join('/') };
}

function createApp({ engine, documents, keys, users, config, version, setup = null }) {
  // True while the first admin account has still to be made in the page.
  // Once any admin exists (made here or on the command line) the setup
  // code is withdrawn for good.
  const needsSetup = () => {
    if (!setup || !setup.pending) return false;
    if (users.hasActiveAdmin()) {
      setup.finish();
      return false;
    }
    return true;
  };
  if (!config.shared) config.shared = { vaults: [], partitions: [] };
  let connection = null;
  let connectionCheckedAt = 0;
  let connectionInFlight = null;
  let listeningPort = config.port;
  const ui = {};
  for (const [route, [file, type]] of Object.entries(UI_FILES)) {
    ui[route] = { body: fs.readFileSync(path.join(UI_DIR, file)), type };
  }

  // One check at a time: callers that arrive while a check is running share
  // its answer, so a burst of requests asks ModelBrain once.
  async function getConnection() {
    const age = Date.now() - connectionCheckedAt;
    const freshFor = connection && connection.connected ? CONNECTION_FRESH_MS : CONNECTION_RETRY_MS;
    if (connection && age < freshFor) return connection;
    if (!connectionInFlight) {
      connectionInFlight = (async () => {
        const diag = await engine.call('diagnostics', {}, 30000);
        const match = matchConnector(Array.isArray(diag.connectors) ? diag.connectors : [], documents.root);
        const skipped = match ? match.segments.find((seg) => seg.startsWith('.') || SKIPPED_FOLDER_NAMES.includes(seg.toLowerCase())) : null;
        connection = {
          connectors: (Array.isArray(diag.connectors) ? diag.connectors : [])
            .filter((c) => c && typeof c.id === 'string')
            .map((c) => ({
              id: c.id,
              kind: typeof c.kind === 'string' ? c.kind : 'folder',
              root: typeof c.root === 'string' ? c.root : null,
              files: Number.isInteger(c.synced) ? c.synced : null,
            })),
          connected: Boolean(match),
          connectorId: match ? match.id : null,
          prefix: match ? match.prefix : '',
          segments: match ? match.segments : [],
          warning: skipped ? `ModelBrain skips folders named "${skipped}", so the documents folder will not be indexed where it is. Move it.` : null,
          modelbrainVersion: typeof diag.version === 'string' ? diag.version : engine.version(),
          degraded: Boolean(diag.degraded),
        };
        connectionCheckedAt = Date.now();
        return connection;
      })().finally(() => {
        connectionInFlight = null;
      });
    }
    return connectionInFlight;
  }

  let partitions = null;
  let partitionsAt = 0;
  let partitionsInFlight = null;

  // ModelBrain's partitions, asked for at most every 30 seconds.
  async function getPartitions() {
    if (partitions && Date.now() - partitionsAt < PARTITIONS_FRESH_MS) return partitions;
    if (!partitionsInFlight) {
      partitionsInFlight = (async () => {
        const result = await engine.call('partition_list', {}, 30000);
        partitions = (Array.isArray(result.partitions) ? result.partitions : [])
          .filter((p) => p && typeof p.id === 'string' && !p.archived)
          .map((p) => ({ id: p.id, name: typeof p.display_name === 'string' ? p.display_name : p.id, is_default: Boolean(p.is_default) }));
        partitionsAt = Date.now();
        return partitions;
      })().finally(() => {
        partitionsInFlight = null;
      });
    }
    return partitionsInFlight;
  }

  function shared(kind) {
    return kind === 'vault' ? config.shared.vaults : config.shared.partitions;
  }

  // Turns sharing of one vault or partition on or off and saves the choice.
  function setShared(kind, id, on) {
    const list = shared(kind).filter((entry) => entry !== id);
    if (on) list.push(id);
    if (kind === 'vault') config.shared.vaults = list;
    else config.shared.partitions = list;
    if (config.dir) {
      const saved = readSavedSettings();
      saved.shared = { vaults: config.shared.vaults, partitions: config.shared.partitions };
      configStore.saveSettings(config.dir, saved);
    }
  }

  function readSavedSettings() {
    try {
      return configStore.loadSettings(config.dir);
    } catch (err) {
      throw new HttpError(409, 'settings_file_damaged', err.message);
    }
  }

  // The vaults this caller may see. Admins see every vault ModelBrain has,
  // each marked shared or not; everyone else sees only shared ones they
  // are allowed to use.
  async function listVaults(who) {
    const conn = await getConnection();
    const admin = allows(who, 'admin');
    return conn.connectors
      .filter((c) => admin || (shared('vault').includes(c.id) && allowsSource(who, 'vault', c.id)))
      .map((c) => ({
        id: c.id,
        kind: c.kind,
        files: c.files,
        shared: shared('vault').includes(c.id),
        documents_folder: conn.connected && c.id === conn.connectorId,
        ...(admin ? { root: c.root } : {}),
      }));
  }

  async function listPartitions(who) {
    const all = await getPartitions();
    const admin = allows(who, 'admin');
    return all
      .filter((p) => admin || (shared('partition').includes(p.id) && allowsSource(who, 'partition', p.id)))
      .map((p) => ({ id: p.id, name: p.name, is_default: p.is_default, shared: shared('partition').includes(p.id) }));
  }

  function notConnectedMessage() {
    return `ModelBrain is not indexing the documents folder yet. In the ModelBrain app, choose Add Vault and pick this folder: ${documents.root}`;
  }

  function send(res, status, body, headers = {}) {
    const payload = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    });
    res.end(payload);
  }

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > limit) {
        reject(new HttpError(413, 'too_large', `The request body is larger than ${limit} bytes.`));
        req.resume();
        return;
      }
      const chunks = [];
      let size = 0;
      let failed = false;
      req.on('data', (chunk) => {
        if (failed) return;
        size += chunk.length;
        if (size > limit) {
          failed = true;
          reject(new HttpError(413, 'too_large', `The request body is larger than ${limit} bytes.`));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (!failed) resolve(Buffer.concat(chunks));
      });
      req.on('error', (err) => {
        if (!failed) reject(new HttpError(400, 'bad_request', err.message));
      });
    });
  }

  async function readJson(req, limit = JSON_BODY_LIMIT) {
    const raw = await readBody(req, limit);
    if (raw.length === 0) return {};
    let parsed;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new HttpError(400, 'invalid_json', 'The request body is not valid JSON.');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, 'invalid_json', 'The request body must be a JSON object.');
    }
    return parsed;
  }

  function ownOrigins() {
    return [`http://127.0.0.1:${listeningPort}`, `http://localhost:${listeningPort}`, `http://[::1]:${listeningPort}`];
  }

  // Refuses requests that did not come to this computer's own address. This
  // stops a web page in a browser from reaching the server through a
  // look-alike host name.
  function checkHost(req) {
    const host = String(req.headers.host || '').toLowerCase();
    if (!ownOrigins().includes(`http://${host}`)) {
      throw new HttpError(403, 'host_not_allowed', 'This server only answers requests sent to 127.0.0.1 or localhost.');
    }
  }

  // Browsers send an Origin header. This server's own page is allowed;
  // other web pages are refused unless their origin was allowed on purpose.
  function corsHeaders(req) {
    const origin = req.headers.origin;
    if (origin === undefined || ownOrigins().includes(origin)) return {};
    if (!config.allowOrigins.includes(origin)) {
      throw new HttpError(403, 'origin_not_allowed', 'Requests from web pages are refused unless the origin is allowed in settings.');
    }
    return {
      'Access-Control-Allow-Origin': origin,
      Vary: 'Origin',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '600',
    };
  }

  // Who is asking: an API key or a signed-in user.
  function authenticate(req) {
    const header = String(req.headers.authorization || '');
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    let who = null;
    if (match) who = SESSION_PATTERN.test(match[1]) ? users.verifySession(match[1]) : keys.verify(match[1]);
    if (!who) {
      throw new HttpError(401, 'not_signed_in', 'Sign in, or send a valid API key as "Authorization: Bearer <key>".');
    }
    return { who, token: match[1] };
  }

  function need(who, access) {
    if (!allows(who, access)) {
      throw new HttpError(403, 'access_denied', `This ${who.kind === 'user' ? 'account' : 'key'} has "${who.access}" access; this request needs "${access}".`);
    }
  }

  function needCollection(who, collection) {
    if (!allowsCollection(who, collection)) {
      throw new HttpError(403, 'collection_denied', `This ${who.kind === 'user' ? 'account' : 'key'} is not allowed to use the collection "${collection}".`);
    }
  }

  function segments(req) {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      return url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
    } catch {
      throw new HttpError(400, 'bad_request', 'The address is not valid.');
    }
  }

  function describe(who) {
    return { kind: who.kind, name: who.name, access: who.access, collections: who.collections };
  }

  async function status(who) {
    // The folder's full path is shown only to keys and users that are not
    // limited to collections.
    const showPath = !who.collections;
    const out = {
      name: 'modelbrain-rag',
      version,
      modelbrain: { installed: engine.installed(), reachable: false, version: null },
      documents_folder: { path: showPath ? documents.root : null, connected: false, connector_id: null },
      signed_in: describe(who),
    };
    if (!engine.installed()) {
      out.modelbrain.message = `ModelBrain is not installed on this computer: ${DOWNLOAD_URL}`;
      return out;
    }
    try {
      const conn = await getConnection();
      out.modelbrain.reachable = true;
      out.modelbrain.version = conn.modelbrainVersion;
      out.modelbrain.degraded = conn.degraded;
      out.documents_folder.connected = conn.connected;
      out.documents_folder.connector_id = conn.connectorId;
      if (!conn.connected) out.documents_folder.message = showPath ? notConnectedMessage() : 'ModelBrain is not indexing the documents folder yet. Ask an administrator.';
      else if (conn.warning) out.documents_folder.message = conn.warning;
    } catch (err) {
      out.modelbrain.message = err.message;
    }
    return out;
  }

  async function search(who, body) {
    const query = body.query;
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw new HttpError(400, 'invalid_query', 'Send a "query" with the text to search for.');
    }
    if (query.length > MAX_QUERY_LENGTH) {
      throw new HttpError(400, 'invalid_query', `The query is longer than ${MAX_QUERY_LENGTH} characters.`);
    }
    const k = body.k === undefined ? 5 : body.k;
    if (!Number.isInteger(k) || k < 1 || k > 50) {
      throw new HttpError(400, 'invalid_k', '"k" must be a whole number from 1 to 50.');
    }
    const has = (field) => body[field] !== undefined && body[field] !== null;
    const targets = ['collection', 'vault', 'partition'].filter(has);
    if (targets.length > 1) {
      throw new HttpError(400, 'one_target', 'Name one of "collection", "vault" or "partition", not several.');
    }
    if (targets.length === 0 && who.collections) {
      throw new HttpError(400, 'collection_required', 'This account or key is limited to certain sources, so the search must name a "collection", "vault" or "partition".');
    }
    const args = { query, k };
    if (body.min_score !== undefined) {
      if (typeof body.min_score !== 'number' || !(body.min_score >= 0 && body.min_score <= 1)) {
        throw new HttpError(400, 'invalid_min_score', '"min_score" must be a number from 0 to 1.');
      }
      args.min_relevance = body.min_score;
    }
    if (body.merge_chunks !== undefined) {
      if (typeof body.merge_chunks !== 'boolean') throw new HttpError(400, 'invalid_merge_chunks', '"merge_chunks" must be true or false.');
      args.collapse_sources = body.merge_chunks;
    }
    if (has('folder') && !has('vault')) {
      throw new HttpError(400, 'invalid_folder', '"folder" narrows a vault search, so it needs "vault".');
    }

    let collection = null;
    let vault = null;
    let partition = null;
    let keep;
    let place;

    if (has('partition')) {
      if (typeof body.partition !== 'string' || body.partition.length === 0 || body.partition.length > 200) {
        throw new HttpError(400, 'invalid_partition', '"partition" must be a partition id or name.');
      }
      const wanted = body.partition.toLowerCase();
      const all = await getPartitions();
      const found = all.find((p) => p.id.toLowerCase() === wanted) || all.find((p) => p.name.toLowerCase() === wanted);
      // The same answer whether the partition does not exist, is not
      // shared or is not allowed, so nothing is learned by guessing names.
      if (!found || !shared('partition').includes(found.id) || !allowsSource(who, 'partition', found.id)) {
        throw new HttpError(404, 'partition_not_available', `There is no shared partition "${body.partition}" for this account or key.`);
      }
      partition = { id: found.id, name: found.name };
      args.scope = 'all';
      args.partition_scope = `id:${found.id}`;
      keep = (hit) => hit.partition_id === found.id;
      place = (hit) => ({ collection: null, document: typeof hit.source_uri === 'string' ? hit.source_uri : null });
    } else if (has('vault')) {
      if (typeof body.vault !== 'string' || body.vault.length === 0 || body.vault.length > 120) {
        throw new HttpError(400, 'invalid_vault', '"vault" must be a vault id.');
      }
      const conn = await getConnection();
      const found = conn.connectors.find((c) => c.id === body.vault);
      if (!found || !shared('vault').includes(found.id) || !allowsSource(who, 'vault', found.id)) {
        throw new HttpError(404, 'vault_not_available', `There is no shared vault "${body.vault}" for this account or key.`);
      }
      vault = found.id;
      args.scope = `connector:${found.id}`;
      if (has('folder')) {
        // eslint-disable-next-line no-control-regex
        if (typeof body.folder !== 'string' || body.folder.length > 500 || /[\u0000-\u001f\u007f]/.test(body.folder) || body.folder.split(/[\\/]/).includes('..')) {
          throw new HttpError(400, 'invalid_folder', '"folder" must be a path inside the vault, such as "Projects/Alpha".');
        }
        args.folder = body.folder;
      }
      keep = (hit) => hit.connector_id === found.id;
      place = (hit) => ({ collection: null, document: typeof hit.source_uri === 'string' ? hit.source_uri : null });
    } else {
      if (has('collection')) {
        needCollection(who, checkName(body.collection, 'Collection'));
        collection = documents.collectionDir(body.collection).name;
      }
      const conn = await getConnection();
      if (!conn.connected) {
        throw new HttpError(409, 'documents_folder_not_connected', who.collections ? 'ModelBrain is not indexing the documents folder yet. Ask an administrator.' : notConnectedMessage());
      }
      args.scope = `connector:${conn.connectorId}`;
      args.folder = [conn.prefix, collection].filter(Boolean).join('/') || '/';
      place = (hit) => splitSource(typeof hit.source_uri === 'string' ? hit.source_uri : '', conn.segments);
      // A hit must come from the documents folder, and from the collection
      // that was asked for when one was. ModelBrain's
      // own filter already does this; this is a second check.
      keep = (hit) => hit.connector_id === conn.connectorId && (!collection || String(place(hit).collection || '').toLowerCase() === collection.toLowerCase());
    }

    const result = await engine.call('recall', args);
    const hits = (Array.isArray(result.hits) ? result.hits : []).filter((hit) => hit && typeof hit === 'object' && keep(hit));
    const results = hits.map((hit) => {
      const where = place(hit);
      // A document sitting directly in a collection can be fetched whole.
      const whole = where.collection && where.document && !/[\\/]/.test(where.document)
        ? `/v1/collections/${encodeURIComponent(where.collection)}/documents/${encodeURIComponent(where.document)}`
        : null;
      return {
        text: typeof hit.text === 'string' ? hit.text : '',
        score: typeof hit.relevance === 'number' ? hit.relevance : null,
        collection: where.collection,
        document: where.document,
        document_url: whole,
        source: hit.source === 'user' ? 'memory' : 'document',
        source_uri: typeof hit.source_uri === 'string' ? hit.source_uri : null,
        headings: Array.isArray(hit.heading_path) ? hit.heading_path.filter((h) => typeof h === 'string') : [],
        date: typeof hit.source_date === 'string' ? hit.source_date : null,
        date_kind: typeof hit.source_date_kind === 'string' ? hit.source_date_kind : null,
        flagged: Boolean(hit.injection_flagged),
        key: typeof hit.key === 'string' ? hit.key : null,
      };
    });
    const out = { query, collection, vault, partition, count: results.length, results };
    if (typeof result.note === 'string') out.note = result.note;
    if (Array.isArray(result.warnings) && result.warnings.length > 0) out.warnings = result.warnings.filter((w) => typeof w === 'string');
    return out;
  }

  function settingsView() {
    return {
      port: config.port,
      listening_port: listeningPort,
      documents_folder: documents.root,
      allow_origins: config.allowOrigins,
      shared: config.shared,
      max_upload_bytes: config.maxUploadBytes,
      settings_dir: config.dir || null,
    };
  }

  async function route(req, res, cors) {
    const parts = segments(req);
    const method = req.method;

    if (parts.length === 1 && parts[0] === 'health' && method === 'GET') {
      return send(res, 200, { ok: true, name: 'modelbrain-rag', version, needs_setup: needsSetup(), ...(needsSetup() ? { setup_id: setup.id() } : {}) }, cors);
    }
    if (parts[0] !== 'v1') throw new HttpError(404, 'not_found', 'There is nothing at this address.');
    const [, area, a, b, c] = parts;

    if (area === 'login' && parts.length === 2 && method === 'POST') {
      const body = await readJson(req, SMALL_BODY_LIMIT);
      const session = await users.login(body.username, body.password);
      return send(res, 200, { token: session.token, expires: session.expires, signed_in: { kind: 'user', name: session.user.username, access: session.user.access, collections: session.user.collections } }, cors);
    }

    // First run from an installer: whoever holds the one-time setup code
    // (written to a file only this user can read) makes the first admin.
    if (area === 'setup' && parts.length === 2 && method === 'POST') {
      const body = await readJson(req, SMALL_BODY_LIMIT);
      if (!needsSetup()) throw new HttpError(404, 'setup_not_available', 'Setup is already done. Sign in instead.');
      const held = setup.take(body.code);
      if (!held) {
        throw new HttpError(403, 'wrong_setup_code', 'That setup link is not valid or has been replaced. Close this tab and open ModelBrain RAG again ("Open ModelBrain RAG" in its install folder, or: modelbrain-rag open).');
      }
      try {
        await users.create({ username: body.username, password: body.password, access: 'admin' });
      } catch (err) {
        setup.restore(held);
        throw err;
      }
      setup.finish();
      const session = await users.login(body.username, body.password);
      return send(res, 201, { token: session.token, expires: session.expires, signed_in: { kind: 'user', name: session.user.username, access: session.user.access, collections: session.user.collections } }, cors);
    }

    const { who, token } = authenticate(req);

    // Reading a request body takes time, and access may be taken away
    // meanwhile. After any body is read, check again that the caller is
    // still who they were, with the same access.
    const stillAllowed = () => {
      const again = authenticate(req).who;
      if (again.kind !== who.kind || again.id !== who.id || again.access !== who.access || JSON.stringify(again.collections) !== JSON.stringify(who.collections)) {
        throw new HttpError(401, 'not_signed_in', 'Your access changed while this request was being sent. Sign in again.');
      }
    };
    const json = async (limit) => {
      const body = await readJson(req, limit);
      stillAllowed();
      return body;
    };
    const bytes = async (limit) => {
      const body = await readBody(req, limit);
      stillAllowed();
      return body;
    };

    if (area === 'logout' && parts.length === 2 && method === 'POST') {
      if (who.kind === 'user') users.logout(token);
      return send(res, 200, { signed_out: true }, cors);
    }

    if (area === 'me' && parts.length === 2 && method === 'GET') {
      return send(res, 200, describe(who), cors);
    }

    if (area === 'me' && a === 'password' && parts.length === 3 && method === 'PUT') {
      if (who.kind !== 'user') throw new HttpError(400, 'not_a_user', 'Only a signed-in user has a password. API keys are replaced, not changed.');
      const body = await json(SMALL_BODY_LIMIT);
      const user = await users.checkPassword(who.name, body.current, 'change');
      if (user.uid !== who.id) throw new HttpError(401, 'not_signed_in', 'Sign in again.');
      await users.update(who.name, { password: body.new });
      // Changing the password ends every session for this user, so hand
      // back a fresh one for the page that made the change.
      const session = users.startSession(users.find(users.users, who.name));
      return send(res, 200, { token: session.token, expires: session.expires }, cors);
    }

    if (area === 'status' && parts.length === 2 && method === 'GET') {
      need(who, 'read');
      return send(res, 200, await status(who), cors);
    }

    if (area === 'search' && parts.length === 2 && method === 'POST') {
      need(who, 'read');
      return send(res, 200, await search(who, await json(JSON_BODY_LIMIT)), cors);
    }

    if (area === 'keys') {
      need(who, 'admin');
      if (parts.length === 2 && method === 'GET') return send(res, 200, { keys: keys.list() }, cors);
      if (parts.length === 2 && method === 'POST') {
        const body = await json(SMALL_BODY_LIMIT);
        const made = keys.create({ name: body.name, access: body.access, collections: body.collections });
        return send(res, 201, { key: made.key, ...made.record, note: 'Store this key now. It cannot be shown again.' }, cors);
      }
      if (parts.length === 3 && method === 'DELETE') return send(res, 200, keys.revoke(a), cors);
    }

    if (area === 'users') {
      need(who, 'admin');
      if (parts.length === 2 && method === 'GET') return send(res, 200, { users: users.list() }, cors);
      if (parts.length === 2 && method === 'POST') {
        const body = await json(SMALL_BODY_LIMIT);
        const made = await users.create({ username: body.username, password: body.password, access: body.access, collections: body.collections });
        return send(res, 201, made, cors);
      }
      if (parts.length === 3 && method === 'PUT') {
        const body = await json(SMALL_BODY_LIMIT);
        const changes = {};
        for (const field of ['access', 'collections', 'disabled', 'password']) {
          if (body[field] !== undefined) changes[field] = body[field];
        }
        return send(res, 200, await users.update(a, changes), cors);
      }
      if (parts.length === 3 && method === 'DELETE') return send(res, 200, users.remove(a), cors);
    }

    if (area === 'settings' && parts.length === 2) {
      need(who, 'admin');
      if (method === 'GET') return send(res, 200, settingsView(), cors);
      if (method === 'PUT') {
        if (!config.dir) throw new HttpError(409, 'settings_not_saved', 'This server was started without a settings folder, so settings cannot be saved.');
        const body = await json(SMALL_BODY_LIMIT);
        let port;
        try {
          port = configStore.checkPort(body.port);
        } catch (err) {
          throw new HttpError(400, 'invalid_port', err.message);
        }
        const saved = readSavedSettings();
        saved.port = port;
        configStore.saveSettings(config.dir, saved);
        config.port = port;
        return send(res, 200, { ...settingsView(), restart_required: port !== listeningPort }, cors);
      }
    }

    if (area === 'vaults' || area === 'partitions') {
      const kind = area === 'vaults' ? 'vault' : 'partition';
      if (parts.length === 2 && method === 'GET') {
        need(who, 'read');
        const list = kind === 'vault' ? await listVaults(who) : await listPartitions(who);
        return send(res, 200, { [area]: list }, cors);
      }
      if (parts.length === 3 && method === 'PUT') {
        need(who, 'admin');
        const body = await json(SMALL_BODY_LIMIT);
        if (typeof body.shared !== 'boolean') throw new HttpError(400, 'invalid_shared', 'Send "shared": true or false.');
        const known = kind === 'vault' ? (await getConnection()).connectors : await getPartitions();
        const found = known.find((entry) => entry.id === a);
        // Sharing needs a vault or partition ModelBrain has now. Unsharing
        // works for one that has since gone.
        if (!found && body.shared) throw new HttpError(404, `${kind}_not_found`, `ModelBrain has no ${kind} with id "${a}".`);
        setShared(kind, a, body.shared);
        return send(res, 200, { id: a, shared: body.shared }, cors);
      }
    }

    if (area === 'collections') {
      if (parts.length === 2 && method === 'GET') {
        need(who, 'read');
        const listed = documents.listCollections();
        const out = { collections: listed.collections.filter((col) => allowsCollection(who, col.name)) };
        if (!who.collections) {
          out.folder = documents.root;
          out.skipped = listed.skipped;
        }
        return send(res, 200, out, cors);
      }
      if (parts.length === 2 && method === 'POST') {
        need(who, 'write');
        const body = await json(SMALL_BODY_LIMIT);
        const name = checkName(body.name, 'Collection');
        needCollection(who, name);
        const made = documents.createCollection(name);
        return send(res, made.created ? 201 : 200, made, cors);
      }
      if (parts.length === 3 && method === 'DELETE') {
        need(who, 'write');
        needCollection(who, checkName(a, 'Collection'));
        return send(res, 200, documents.deleteCollection(a), cors);
      }
      if (parts.length === 4 && b === 'documents' && method === 'GET') {
        need(who, 'read');
        needCollection(who, checkName(a, 'Collection'));
        return send(res, 200, documents.listDocuments(a), cors);
      }
      if (parts.length === 4 && b === 'documents' && method === 'POST') {
        need(who, 'write');
        needCollection(who, checkName(a, 'Collection'));
        const body = await json(config.maxUploadBytes);
        if (typeof body.text !== 'string') throw new HttpError(400, 'invalid_document', 'Send "name" and "text". For files that are not plain text, use PUT with the file as the body.');
        const saved = documents.putDocument(a, body.name, Buffer.from(body.text, 'utf8'));
        return send(res, saved.replaced ? 200 : 201, { ...saved, indexing: 'ModelBrain indexes the file shortly after it is written.' }, cors);
      }
      // The whole document, as a download. It is always sent as a file to
      // save and never as a page, so a document's contents cannot run in
      // this server's own web page.
      if (parts.length === 5 && b === 'documents' && method === 'GET') {
        need(who, 'read');
        needCollection(who, checkName(a, 'Collection'));
        const found = documents.findDocument(a, c);
        if (found.bytes > MAX_DOWNLOAD_BYTES) throw new HttpError(413, 'document_too_large', 'This document is too large to send. Open it from the documents folder instead.');
        const data = fs.readFileSync(found.file);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': data.length,
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(found.document)}`,
          'Content-Security-Policy': "sandbox; default-src 'none'",
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          ...cors,
        });
        return res.end(data);
      }
      if (parts.length === 5 && b === 'documents' && method === 'PUT') {
        need(who, 'write');
        needCollection(who, checkName(a, 'Collection'));
        checkName(c, 'Document');
        const file = await bytes(config.maxUploadBytes);
        if (file.length === 0) throw new HttpError(400, 'invalid_document', 'The file is empty.');
        const saved = documents.putDocument(a, c, file);
        return send(res, saved.replaced ? 200 : 201, { ...saved, indexing: 'ModelBrain indexes the file shortly after it is written.' }, cors);
      }
      if (parts.length === 5 && b === 'documents' && method === 'DELETE') {
        need(who, 'write');
        needCollection(who, checkName(a, 'Collection'));
        return send(res, 200, documents.deleteDocument(a, c), cors);
      }
    }

    throw new HttpError(404, 'not_found', 'There is nothing at this address for that method.');
  }

  const server = http.createServer(async (req, res) => {
    let cors = {};
    try {
      checkHost(req);
      cors = corsHeaders(req);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        res.end();
        return;
      }
      const page = req.method === 'GET' ? ui[String(req.url).split('?')[0]] : undefined;
      if (page) {
        res.writeHead(200, {
          'Content-Type': page.type,
          'Content-Length': page.body.length,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          ...UI_HEADERS,
        });
        res.end(page.body);
        return;
      }
      await route(req, res, cors);
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      let statusCode = 500;
      let code = 'internal_error';
      let message = 'Something went wrong inside the server.';
      let extra;
      if (err instanceof HttpError || err instanceof DocumentError || err instanceof KeyError) {
        statusCode = err.status;
        code = err.code;
        message = err.message;
        extra = err.extra;
      } else if (err instanceof EngineError) {
        if (err.code === 'modelbrain_timeout') statusCode = 504;
        else if (err.code === 'modelbrain_tool_error') statusCode = 502;
        else if (err.code === 'invalid_params') statusCode = 400;
        else statusCode = 503;
        code = err.code;
        message = err.message;
      } else if (err && Number.isInteger(err.status) && typeof err.code === 'string' && err.name === 'StoreFileError') {
        statusCode = err.status;
        code = err.code;
        message = err.message;
      } else if (err && (err.code === 'ENOSPC' || err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EROFS')) {
        statusCode = 507;
        code = 'cannot_write';
        message = `The file could not be written: ${err.code}.`;
      }
      // Drain what is left of the request so the reply can be delivered.
      req.resume();
      send(res, statusCode, { error: { code, message, ...(extra || {}) } }, { ...cors, ...(statusCode === 401 ? { 'WWW-Authenticate': 'Bearer' } : {}) });
    }
  });

  server.on('listening', () => {
    const address = server.address();
    if (address && typeof address === 'object') listeningPort = address.port;
  });

  return server;
}

module.exports = { createApp, matchConnector, splitSource };
