#!/usr/bin/env node
'use strict';

// Command line for modelbrain-rag: start the server, manage API keys and
// web page users, and change settings.

const fs = require('node:fs');
const path = require('node:path');
const config = require('../lib/config.js');
const { Documents } = require('../lib/documents.js');
const { Engine, findServerBinary, DOWNLOAD_URL } = require('../lib/engine.js');
const { KeyStore, ACCESS_LEVELS } = require('../lib/keys.js');
const { createApp } = require('../lib/server.js');
const { UserStore, generatePassword } = require('../lib/users.js');
const { Setup, readCode, idForCode, writeOpener } = require('../lib/setup.js');
const service = require('../lib/service.js');
const { version } = require('../package.json');

const HELP = `modelbrain-rag ${version}
Document search server for ModelBrain. Needs the ModelBrain app installed.

Usage:
  modelbrain-rag [start] [--port N] [--docs-dir PATH] [--allow-origin URL]
  modelbrain-rag status
  modelbrain-rag open                 open the web page in your browser
  modelbrain-rag service install      start at sign-in, in the background
  modelbrain-rag service uninstall
  modelbrain-rag service status

  API keys (for apps and scripts):
  modelbrain-rag keys list
  modelbrain-rag keys create --name NAME [--access read|write|admin] [--collections A,B]
  modelbrain-rag keys revoke ID
  modelbrain-rag keys prune

  Users (for the web page):
  modelbrain-rag users list
  modelbrain-rag users create --username NAME [--access read|write|admin] [--collections A,B] [--password-stdin]
  modelbrain-rag users set-password NAME [--password-stdin]
  modelbrain-rag users set-access NAME --access read|write|admin
  modelbrain-rag users disable NAME
  modelbrain-rag users enable NAME
  modelbrain-rag users remove NAME

  Settings:
  modelbrain-rag config show
  modelbrain-rag config set port N
  modelbrain-rag config set docs-dir PATH
  modelbrain-rag config set allow-origin URL[,URL]
  modelbrain-rag config set allow-origin none

A password is made for you and printed once. To choose one, pipe it in with
--password-stdin. (--password P also works, but the password then shows in
your shell history and in the list of running programs.)
--collections may also hold vault:ID and partition:ID entries for shared
vaults and partitions.
Settings can also come from the environment: MODELBRAIN_RAG_PORT,
MODELBRAIN_RAG_DIR, MODELBRAIN_RAG_CONFIG_DIR, MODELBRAIN_RAG_MCP_SERVER.
`;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

// Splits arguments into words and --flag value pairs.
function parse(argv) {
  const words = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--version' || arg === '-v') flags.version = true;
    else if (arg === '--password-stdin') flags['password-stdin'] = true;
    else if (arg === '--service') flags.service = true;
    else if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const value = eq === -1 ? argv[(i += 1)] : arg.slice(eq + 1);
      if (value === undefined) fail(`--${name} needs a value.`);
      flags[name] = value;
    } else words.push(arg);
  }
  return { words, flags };
}

function list(value) {
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// The password for a users command: --password-stdin reads it from standard
// input (so it never shows in a process list or shell history), --password
// takes it from the command line, and with neither one is made.
function passwordFrom(flags) {
  if (flags['password-stdin'] !== undefined) {
    const text = fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
    if (!text) fail('No password arrived on standard input.');
    return { password: text, generated: false };
  }
  if (flags.password) return { password: flags.password, generated: false };
  return { password: generatePassword(), generated: true };
}

function resolved(flags) {
  try {
    return config.resolve({
      flags: {
        port: flags.port,
        docsDir: flags['docs-dir'],
        allowOrigins: flags['allow-origin'] ? list(flags['allow-origin']) : undefined,
      },
    });
  } catch (err) {
    return fail(err.message);
  }
}

function keysCommand(words, flags) {
  const settings = resolved(flags);
  const action = words[1];
  try {
    const store = new KeyStore(settings.keysFile);
    if (action === 'list') {
      const keys = store.list();
      if (keys.length === 0) return process.stdout.write('No keys yet. Start the server once, or run: modelbrain-rag keys create --name NAME --access admin\n');
      for (const k of keys) {
        const scope = k.collections ? ` collections=${k.collections.join(',')}` : '';
        const state = k.revoked ? ` REVOKED ${k.revoked}` : '';
        process.stdout.write(`${k.id}  ${k.access.padEnd(5)}  ${k.name}${scope}  created ${k.created}  last used ${k.last_used || 'never'}${state}\n`);
      }
      return undefined;
    }
    if (action === 'create') {
      const made = store.create({
        name: flags.name,
        access: flags.access || 'read',
        collections: flags.collections ? list(flags.collections) : null,
      });
      process.stdout.write(`Key "${made.record.name}" (${made.record.access}), id ${made.record.id}:\n\n  ${made.key}\n\nStore it now. It cannot be shown again.\n`);
      return undefined;
    }
    if (action === 'revoke') {
      if (!words[2]) fail('Which key? Run: modelbrain-rag keys revoke ID');
      const record = store.revoke(words[2]);
      return process.stdout.write(`Revoked key ${record.id} (${record.name}).\n`);
    }
    if (action === 'prune') {
      return process.stdout.write(`Removed ${store.prune()} revoked key(s).\n`);
    }
  } catch (err) {
    return fail(err.message);
  }
  return fail(`Unknown keys command. Access levels are: ${ACCESS_LEVELS.join(', ')}.\n\n${HELP}`);
}

async function usersCommand(words, flags) {
  const settings = resolved(flags);
  const action = words[1];
  const who = words[2];
  try {
    const store = new UserStore(settings.usersFile);
    if (action === 'list') {
      const users = store.list();
      if (users.length === 0) return process.stdout.write('No users yet. Start the server once, or run: modelbrain-rag users create --username NAME --access admin\n');
      for (const u of users) {
        const scope = u.collections ? ` collections=${u.collections.join(',')}` : '';
        process.stdout.write(`${u.username}  ${u.access.padEnd(5)}${scope}  last sign-in ${u.last_login || 'never'}${u.disabled ? '  DISABLED' : ''}\n`);
      }
      return undefined;
    }
    if (action === 'create') {
      const { password, generated } = passwordFrom(flags);
      const made = await store.create({
        username: flags.username,
        password,
        access: flags.access || 'read',
        collections: flags.collections ? list(flags.collections) : null,
      });
      process.stdout.write(`Made user "${made.username}" (${made.access}).\n`);
      if (generated) process.stdout.write(`\n  Password: ${password}\n\nStore it now. It cannot be shown again. The user can change it after signing in.\n`);
      return undefined;
    }
    if (!who && ['set-password', 'set-access', 'disable', 'enable', 'remove'].includes(action)) fail(`Which user? Run: modelbrain-rag users ${action} NAME`);
    if (action === 'set-password') {
      const { password, generated } = passwordFrom(flags);
      await store.update(who, { password });
      process.stdout.write(`Password changed for "${who}". Anyone signed in as this user is signed out.\n`);
      if (generated) process.stdout.write(`\n  Password: ${password}\n\nStore it now. It cannot be shown again.\n`);
      return undefined;
    }
    if (action === 'set-access') {
      const changed = await store.update(who, { access: flags.access, collections: flags.collections ? list(flags.collections) : undefined });
      return process.stdout.write(`"${changed.username}" now has ${changed.access} access.\n`);
    }
    if (action === 'disable' || action === 'enable') {
      await store.update(who, { disabled: action === 'disable' });
      return process.stdout.write(`"${who}" is ${action === 'disable' ? 'disabled' : 'enabled'}.\n`);
    }
    if (action === 'remove') {
      store.remove(who);
      return process.stdout.write(`Removed user "${who}".\n`);
    }
  } catch (err) {
    return fail(err.message);
  }
  return fail(`Unknown users command.\n\n${HELP}`);
}

function configCommand(words) {
  const dir = config.configDir();
  let saved;
  try {
    saved = config.loadSettings(dir);
  } catch (err) {
    return fail(err.message);
  }
  if (words[1] === 'show') {
    const now = resolved({});
    process.stdout.write(
      `Settings folder: ${now.dir}\nPort: ${now.port}\nDocuments folder: ${now.docsDir}\nAllowed web origins: ${now.allowOrigins.join(', ') || 'none'}\nLargest upload: ${now.maxUploadBytes} bytes\n`
    );
    return undefined;
  }
  if (words[1] === 'set' && words[2] && words[3] !== undefined) {
    const value = words[3];
    try {
      if (words[2] === 'port') saved.port = config.checkPort(value);
      else if (words[2] === 'docs-dir') saved.docsDir = path.resolve(value);
      else if (words[2] === 'allow-origin') saved.allowOrigins = value === 'none' ? [] : config.checkOrigins(list(value));
      else fail(`Unknown setting "${words[2]}".`);
    } catch (err) {
      return fail(err.message);
    }
    config.saveSettings(dir, saved);
    process.stdout.write('Saved. Restart modelbrain-rag for the change to take effect.\n');
    return undefined;
  }
  return fail(HELP);
}

function statusCommand(flags) {
  const settings = resolved(flags);
  const binary = findServerBinary();
  let keys = 0;
  let users = 0;
  try {
    keys = new KeyStore(settings.keysFile).list().filter((k) => !k.revoked).length;
    users = new UserStore(settings.usersFile).list().filter((u) => !u.disabled).length;
  } catch (err) {
    return fail(err.message);
  }
  process.stdout.write(
    [
      `modelbrain-rag ${version}`,
      `ModelBrain: ${binary ? `found at ${binary}` : `not installed (${DOWNLOAD_URL})`}`,
      `Address: http://127.0.0.1:${settings.port}`,
      `Documents folder: ${settings.docsDir}${fs.existsSync(settings.docsDir) ? '' : ' (not created yet)'}`,
      `Keys: ${keys} active`,
      `Users: ${users} active`,
      '',
    ].join('\n')
  );
  return undefined;
}

async function start(flags) {
  const settings = resolved(flags);
  let documents;
  let keys;
  let users;
  let setup = null;
  try {
    documents = new Documents(settings.docsDir);
    documents.ensureRoot();
    keys = new KeyStore(settings.keysFile);
    users = new UserStore(settings.usersFile);
    if (flags.service) {
      // Started in the background: there is no terminal to print a first
      // password to, so the first admin is made in the web page with a
      // one-time setup code. API keys are then made in the page.
      // The code is written only once the port is ours (see below), so a
      // second copy that fails to start cannot replace a running one's code.
      setup = new Setup(settings.dir);
    } else if (!keys.hasActiveAdmin()) {
      const made = keys.create({ name: 'admin', access: 'admin' });
      process.stdout.write(`First run: made an admin API key for apps and scripts.\n\n  ${made.key}\n\n`);
    }
    if (!flags.service && !users.hasActiveAdmin()) {
      const password = generatePassword();
      const name = users.list().some((u) => u.username.toLowerCase() === 'admin') ? `admin-${Date.now().toString(36)}` : 'admin';
      await users.create({ username: name, password, access: 'admin' });
      process.stdout.write(`First run: made an admin user for the web page.\n\n  Username: ${name}\n  Password: ${password}\n\n`);
      process.stdout.write('Store these now. They cannot be shown again. Change the password after signing in.\n\n');
    }
  } catch (err) {
    return fail(err.message);
  }
  const binary = findServerBinary();
  const engine = new Engine({ command: binary, clientVersion: version });
  const server = createApp({ engine, documents, keys, users, config: settings, version, setup });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      fail(`Port ${settings.port} is already in use. Pick another with: modelbrain-rag config set port N`);
    }
    fail(`Could not start: ${err.message}`);
  });
  server.listen(settings.port, '127.0.0.1', () => {
    if (setup) {
      try {
        if (users.hasActiveAdmin()) setup.finish();
        else setup.begin();
      } catch (err) {
        process.stderr.write(`Could not write the setup code: ${err.message}\n`);
      }
    }
    process.stdout.write(
      [
        `modelbrain-rag ${version} is running.`,
        `Web page and API: http://127.0.0.1:${settings.port}`,
        `Documents folder: ${settings.docsDir}`,
        binary
          ? 'ModelBrain found. If this is the first run, ModelBrain may ask you to allow "ModelBrain RAG".'
          : `ModelBrain is not installed, so searches will fail until it is: ${DOWNLOAD_URL}`,
        'The documents folder must be added once in the ModelBrain app (Add Vault). The Status page shows whether it is.',
        '',
      ].join('\n')
    );
  });

  const stop = () => {
    if (setup && setup.pending) setup.finish();
    keys.flush();
    engine.stop();
    server.close(() => process.exit(0));
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return undefined;
}

// Opens the web page in the default browser. On a first run it carries the
// one-time setup code in the address fragment, which is never sent to a
// server.
async function openCommand(flags) {
  const settings = resolved(flags);
  const base = `http://127.0.0.1:${settings.port}`;
  let health = null;
  for (let i = 0; i < 40 && !health; i += 1) {
    try {
      const body = await (await fetch(`${base}/health`)).json();
      if (body && body.name === 'modelbrain-rag') health = body;
      else break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!health) return fail(`ModelBrain RAG is not answering at ${base}. Start it with: modelbrain-rag service install`);
  let target = `${base}/`;
  if (health.needs_setup) {
    // The setup code goes only to the server that wrote it. Its /health
    // carries a value only the holder of the code file can work out.
    const code = readCode(settings.dir);
    if (code && health.setup_id === idForCode(code)) {
      target = writeOpener(settings.dir, `${base}/#setup=${code}`);
    } else if (code) {
      return fail(`The program answering at ${base} is not the ModelBrain RAG server started for this account, so the setup code was not sent to it. Another copy may be using port ${settings.port}; pick another with: modelbrain-rag config set port N`);
    }
  }
  const [command, args] = service.browserCommand(target);
  const { spawn } = require('node:child_process');
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => fail(`Could not open a browser. Go to ${base} yourself.`));
  child.unref();
  process.stdout.write(`Opening ${base}\n`);
  return undefined;
}

function serviceCommand(words, flags) {
  const settings = resolved(flags);
  const action = words[1];
  try {
    if (action === 'install') {
      if (flags.port || flags['docs-dir'] || flags['allow-origin']) {
        return fail('Save settings first with "modelbrain-rag config set ...". The background server reads saved settings, not command-line flags.');
      }
      const file = service.install({ script: path.resolve(__filename), logDir: settings.dir });
      process.stdout.write(`ModelBrain RAG now starts when you sign in, and is starting now.\nEntry: ${file}\nOpen the web page with: modelbrain-rag open\n`);
    } else if (action === 'uninstall') {
      process.stdout.write(service.uninstall() ? 'Stopped. ModelBrain RAG no longer starts when you sign in. Your documents and settings were left alone.\n' : 'There was no start-at-sign-in entry.\n');
    } else if (action === 'status') {
      process.stdout.write(service.installed() ? `Starts at sign-in: yes (${service.paths().file})\n` : 'Starts at sign-in: no\n');
    } else return fail(HELP);
  } catch (err) {
    return fail(err.message);
  }
  return undefined;
}

function main() {
  const { words, flags } = parse(process.argv.slice(2));
  if (flags.help) return process.stdout.write(HELP);
  if (flags.version) return process.stdout.write(`${version}\n`);
  const command = words[0] || 'start';
  if (command === 'start') return start(flags);
  if (command === 'status') return statusCommand(flags);
  if (command === 'open') return openCommand(flags);
  if (command === 'service') return serviceCommand(words, flags);
  if (command === 'keys') return keysCommand(words, flags);
  if (command === 'users') return usersCommand(words, flags);
  if (command === 'config') return configCommand(words);
  return fail(HELP);
}

if (require.main === module) {
  Promise.resolve()
    .then(main)
    .catch((err) => fail(err && err.message ? err.message : String(err)));
}
