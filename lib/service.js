'use strict';

// Start at sign-in, without a terminal.
//
// macOS: a LaunchAgent for the signed-in user. Linux: a systemd user unit.
// Windows: done by the Windows installer, not here.
// Nothing here needs administrator rights and nothing is installed for
// other users of the computer.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LABEL = 'net.modelbrain.rag';
const UNIT = 'modelbrain-rag.service';

function xml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// The MODELBRAIN_RAG_* settings in force when the service is installed are
// carried into it, so the background server and later commands in the same
// shell agree on where things are.
function settingsEnv(env = process.env) {
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith('MODELBRAIN_RAG_') && value) out[name] = value;
  }
  return out;
}

function launchAgentPlist({ node, script, logFile, env = {} }) {
  const vars = Object.entries(env).map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`).join('\n');
  const envBlock = vars ? `  <key>EnvironmentVariables</key>\n  <dict>\n${vars}\n  </dict>\n` : '';
  const args = [node, script, 'start', '--service'].map((a) => `    <string>${xml(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
${envBlock}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logFile)}</string>
</dict>
</plist>
`;
}

// systemd splits ExecStart on spaces, so each word is quoted.
function systemdQuote(text) {
  return `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
}

function systemdUnit({ node, script, env = {} }) {
  const vars = Object.entries(env).map(([k, v]) => `Environment=${systemdQuote(`${k}=${v}`)}\n`).join('');
  return `[Unit]
Description=ModelBrain RAG document search server

[Service]
${vars}ExecStart=${systemdQuote(node)} ${systemdQuote(script)} start --service
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
`;
}

function paths(platform = process.platform, home = os.homedir()) {
  // Built with forward slashes whatever system this code happens to run on,
  // since these are macOS and Linux locations.
  if (platform === 'darwin') return { file: path.posix.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`) };
  if (platform === 'linux') return { file: path.posix.join(home, '.config', 'systemd', 'user', UNIT) };
  return null;
}

function run(command, args) {
  try {
    execFileSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    return null;
  } catch (err) {
    return (err.stderr && String(err.stderr).trim()) || err.message;
  }
}

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// macOS takes a moment to let go of a stopped job, and refuses to load it
// again until it has. Wait for it to go, then load with a few tries.
function reloadLaunchAgent(target, file) {
  run('launchctl', ['bootout', `${target}/${LABEL}`]);
  for (let i = 0; i < 40 && run('launchctl', ['print', `${target}/${LABEL}`]) === null; i += 1) pause(250);
  let problem = null;
  for (let i = 0; i < 5; i += 1) {
    problem = run('launchctl', ['bootstrap', target, file]);
    if (!problem) return null;
    pause(1000);
  }
  return problem;
}

function unsupported() {
  return new Error('Start at sign-in is set up by the installer on this system. On macOS and Linux this command does it.');
}

// Sets the server to start when this user signs in, and starts it now.
function install({ node = process.execPath, script, logDir, platform = process.platform, env = settingsEnv() }) {
  const where = paths(platform);
  if (!where) throw unsupported();
  fs.mkdirSync(path.dirname(where.file), { recursive: true });
  if (platform === 'darwin') {
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const target = `gui/${process.getuid()}`;
    fs.writeFileSync(where.file, launchAgentPlist({ node, script, logFile: path.join(logDir, 'server.log'), env }), { mode: 0o644 });
    const problem = reloadLaunchAgent(target, where.file);
    if (problem) throw new Error(`The start-at-sign-in entry was written to ${where.file}, but macOS did not load it: ${problem}`);
  } else {
    fs.writeFileSync(where.file, systemdUnit({ node, script, env }), { mode: 0o644 });
    const problem = run('systemctl', ['--user', 'daemon-reload']) || run('systemctl', ['--user', 'enable', UNIT]) || run('systemctl', ['--user', 'restart', UNIT]);
    if (problem) throw new Error(`The start-at-sign-in entry was written to ${where.file}, but systemd did not start it: ${problem}`);
  }
  return where.file;
}

// Stops the server and removes the start-at-sign-in entry.
function uninstall({ platform = process.platform } = {}) {
  const where = paths(platform);
  if (!where) throw unsupported();
  if (platform === 'darwin') run('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`]);
  else run('systemctl', ['--user', 'disable', '--now', UNIT]);
  const had = fs.existsSync(where.file);
  if (had) fs.unlinkSync(where.file);
  if (platform === 'linux') run('systemctl', ['--user', 'daemon-reload']);
  return had;
}

function installed({ platform = process.platform } = {}) {
  const where = paths(platform);
  return Boolean(where && fs.existsSync(where.file));
}

// The command that opens an address in the default browser.
function browserCommand(url, platform = process.platform) {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  return ['xdg-open', [url]];
}

module.exports = { install, uninstall, installed, paths, launchAgentPlist, systemdUnit, browserCommand, settingsEnv, LABEL, UNIT };
