'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const cp = require('node:child_process');

const OVERRIDES = Object.freeze({
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: '131072',
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '85',
  // Desktop forces API_FORCE_IDLE_TIMEOUT=1, so a stream that sends no bytes for about five
  // minutes is abandoned. Ollama sends nothing while it generates a long tool call.
  API_FORCE_IDLE_TIMEOUT: '0',
  CLAUDE_STREAM_IDLE_TIMEOUT_MS: '1800000',
  API_TIMEOUT_MS: '2400000',
});
const SUMMARY = `window=${OVERRIDES.CLAUDE_CODE_AUTO_COMPACT_WINDOW}; ` +
  `stream idle timeout=${Number(OVERRIDES.CLAUDE_STREAM_IDLE_TIMEOUT_MS) / 1000}s`;
const BACKUP_NAME = '.ccd-context-backup.json';
const ID = /^[0-9a-f]{8}$/i;
const APP = '/Applications/Claude.app';

class ConfigError extends Error {}

function locations(home = os.homedir()) {
  const profile = path.join(home, 'Library/Application Support/Claude-3p');
  const state = path.join(profile, 'context-window-helper');
  return {
    root: path.join(profile, 'local-agent-mode-sessions'),
    state,
    pid: path.join(state, 'watcher.json'),
    log: path.join(state, 'watcher.log'),
  };
}

function stat(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function requireDirectory(dir) {
  const info = stat(dir);
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw new ConfigError(`Not a regular directory (symlinks are refused): ${dir}`);
  }
}

function readObject(file) {
  const info = stat(file);
  if (!info) return undefined;
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new ConfigError(`Not a regular file (symlinks are refused): ${file}`);
  }
  const raw = fs.readFileSync(file, {
    encoding: 'utf8',
    flag: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  });
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new ConfigError(`Invalid JSON; left untouched: ${file}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(`Expected a JSON object; left untouched: ${file}`);
  }
  return { value, raw, mode: info.mode & 0o777 };
}

function writeObject(file, value, previous) {
  const current = readObject(file);
  if (current?.raw !== previous?.raw) {
    throw new ConfigError(`File changed during update; will retry: ${file}`);
  }
  const temporary = `${file}.ccd-${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', previous?.mode ?? 0o600);
  try {
    try {
      fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (readObject(file)?.raw !== previous?.raw) {
      throw new ConfigError(`File changed during update; will retry: ${file}`);
    }
    if (previous) {
      fs.renameSync(temporary, file);
    } else {
      // A link creates a previously absent file without overwriting a competing writer.
      fs.linkSync(temporary, file);
    }
  } finally {
    if (stat(temporary)) fs.unlinkSync(temporary);
  }
}

function managedDirectory(root, dir) {
  const parts = path.relative(root, dir).split(path.sep);
  if (parts.length !== 4 || parts[3] !== '.claude' || !parts.slice(0, 3).every(p => ID.test(p))) {
    throw new ConfigError(`Refusing a path outside the Cowork session layout: ${dir}`);
  }
  requireDirectory(root);
  let parent = root;
  for (const part of parts) {
    parent = path.join(parent, part);
    requireDirectory(parent);
  }
}

function settingsEnv(settings, file) {
  if (Object.hasOwn(settings, 'env') &&
      (!settings.env || typeof settings.env !== 'object' || Array.isArray(settings.env))) {
    throw new ConfigError(`Expected an env object; left untouched: ${file}`);
  }
  return settings.env ?? {};
}

function readBackup(file) {
  const record = readObject(file);
  if (!record) return undefined;
  const value = record.value;
  // Backups from earlier helper versions record only the keys managed at that time.
  const recorded = value.applied && typeof value.applied === 'object' ? Object.keys(value.applied) : [];
  if (value.version !== 1 || typeof value.settingsExisted !== 'boolean' ||
      typeof value.envExisted !== 'boolean' ||
      !value.original || typeof value.original !== 'object' || recorded.length === 0 ||
      !recorded.every(key =>
        Object.hasOwn(OVERRIDES, key) &&
        typeof value.original[key]?.present === 'boolean' &&
        typeof value.applied[key] === 'string')) {
    throw new ConfigError(`Unrecognized backup; left untouched: ${file}`);
  }
  return record;
}

function configureSession(root, dir) {
  managedDirectory(root, dir);
  const file = path.join(dir, 'settings.json');
  const previous = readObject(file);
  const settings = previous?.value ?? {};
  const env = settingsEnv(settings, file);
  if (Object.entries(OVERRIDES).every(([key, value]) => env[key] === value)) return false;
  const backupFile = path.join(dir, BACKUP_NAME);
  const backup = readBackup(backupFile);
  const missing = Object.keys(OVERRIDES).filter(key => !Object.hasOwn(backup?.value.applied ?? {}, key));
  if (missing.length) {
    // Record originals for every key not yet in the backup, including keys added by a helper upgrade.
    const base = backup?.value ?? {
      version: 1,
      settingsExisted: previous !== undefined,
      envExisted: Object.hasOwn(settings, 'env'),
      original: {},
      applied: {},
    };
    writeObject(backupFile, {
      ...base,
      original: {
        ...base.original,
        ...Object.fromEntries(missing.map(key => [
          key, { present: Object.hasOwn(env, key), ...(Object.hasOwn(env, key) ? { value: env[key] } : {}) },
        ])),
      },
      applied: { ...base.applied, ...Object.fromEntries(missing.map(key => [key, OVERRIDES[key]])) },
    }, backup);
  }
  writeObject(file, { ...settings, env: { ...env, ...OVERRIDES } }, previous);
  return true;
}

function restoreSession(root, dir) {
  managedDirectory(root, dir);
  const backupFile = path.join(dir, BACKUP_NAME);
  const backup = readBackup(backupFile);
  if (!backup) return false;
  const file = path.join(dir, 'settings.json');
  const previous = readObject(file);
  if (previous) {
    const settings = previous.value;
    const env = { ...settingsEnv(settings, file) };
    for (const key of Object.keys(backup.value.applied)) {
      // Preserve a user's later edits rather than restoring an entire old settings file.
      if (env[key] !== backup.value.applied[key]) continue;
      const original = backup.value.original[key];
      if (original.present) env[key] = original.value;
      else delete env[key];
    }
    const restored = { ...settings, env };
    if (!backup.value.envExisted && Object.keys(env).length === 0) delete restored.env;
    if (!backup.value.settingsExisted && Object.keys(restored).length === 0) {
      if (readObject(file)?.raw !== previous.raw) throw new ConfigError(`File changed: ${file}`);
      fs.unlinkSync(file);
    } else {
      writeObject(file, restored, previous);
    }
  }
  fs.unlinkSync(backupFile);
  return true;
}

function scan(root, action = configureSession) {
  requireDirectory(root);
  const result = { sessions: 0, changed: [], errors: [] };
  function visit(dir, depth) {
    if (depth === 3) {
      const config = path.join(dir, '.claude');
      if (!stat(config)) return;
      result.sessions++;
      try {
        if (action(root, config)) result.changed.push(path.relative(root, config));
      } catch (error) {
        if (!(error instanceof ConfigError)) throw error;
        result.errors.push(error.message);
      }
      return;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ID.test(entry.name)) continue;
      if (entry.isSymbolicLink()) {
        result.errors.push(`Refusing symlink: ${path.join(dir, entry.name)}`);
      } else if (entry.isDirectory()) {
        visit(path.join(dir, entry.name), depth + 1);
      }
    }
  }
  visit(root, 0);
  return result;
}

function startWatching(root, report, intervalMs = 2000) {
  let debounce;
  let stopped = false;
  const seenErrors = new Set();
  function sweep() {
    if (stopped) return;
    const result = scan(root);
    for (const file of result.changed) report(`Configured ${file}`);
    for (const error of result.errors) {
      if (!seenErrors.has(error)) report(`ERROR: ${error}`);
    }
    seenErrors.clear();
    result.errors.forEach(error => seenErrors.add(error));
    return result;
  }
  const watcher = fs.watch(root, { recursive: true }, (event, filename) => {
    const parts = filename?.toString().split(path.sep);
    if (parts && (parts.length > 5 || (parts.length === 5 && parts[4] !== 'settings.json'))) return;
    clearTimeout(debounce);
    debounce = setTimeout(sweep, 100);
  });
  watcher.on('error', error => { throw error; });
  const interval = setInterval(sweep, intervalMs);
  function close() {
    stopped = true;
    clearTimeout(debounce);
    clearInterval(interval);
    watcher.close();
  }
  let initialized = false;
  try {
    const initial = sweep();
    initialized = true;
    return { initial, close };
  } finally {
    if (!initialized) close();
  }
}

function watcherRecord(files) {
  const record = readObject(files.pid)?.value;
  if (!record) return undefined;
  if (!Number.isSafeInteger(record.pid) || record.pid < 2 ||
      !/^[0-9a-f]{32}$/.test(record.token)) {
    throw new ConfigError(`Invalid watcher PID record: ${files.pid}`);
  }
  const result = cp.spawnSync('/bin/ps', ['-ww', '-p', String(record.pid), '-o', 'command='], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) throw new Error(result.stderr);
  return {
    ...record,
    alive: result.status === 0 && result.stdout.includes(`${__filename} watch ${record.token}`),
  };
}

function desktopPids(only3p = false) {
  const pattern = '^/Applications/Claude\\.app/Contents/MacOS/Claude' +
    (only3p ? ' .*--3p( |$)' : '( |$)');
  const result = cp.spawnSync('/usr/bin/pgrep', ['-f', pattern], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status === 1) return [];
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim().split(/\s+/).filter(Boolean);
}

function ensureState(files) {
  fs.mkdirSync(files.state, { recursive: true, mode: 0o700 });
  requireDirectory(files.state);
  fs.mkdirSync(files.root, { recursive: true, mode: 0o700 });
  requireDirectory(files.root);
}

function runWatcher(files, token) {
  if (!/^[0-9a-f]{32}$/.test(token ?? '')) throw new Error('A valid watcher token is required.');
  ensureState(files);
  const old = watcherRecord(files);
  if (old?.alive) return;
  if (old) fs.unlinkSync(files.pid);
  const owner = { pid: process.pid, token, ready: false };
  writeObject(files.pid, owner, undefined);
  const log = message => console.log(`${new Date().toISOString()} ${message}`);
  let watcher;
  let lifecycle;
  function cleanup() {
    watcher?.close();
    clearInterval(lifecycle);
    if (readObject(files.pid)?.value.token === token) fs.unlinkSync(files.pid);
  }
  process.once('exit', cleanup);
  process.once('SIGTERM', () => process.exit(0));
  process.once('SIGINT', () => process.exit(0));
  watcher = startWatching(files.root, log);
  writeObject(files.pid, { ...owner, ready: true, initial: watcher.initial }, readObject(files.pid));
  log(`Watching only ${files.root}; ${SUMMARY}; initial errors=${watcher.initial.errors.length}`);
  let lastDesktopSeen = Date.now();
  lifecycle = setInterval(() => {
    if (desktopPids(true).length) lastDesktopSeen = Date.now();
    else if (Date.now() - lastDesktopSeen > 60000) {
      log('Claude 3P is closed; stopping helper.');
      process.exit(0);
    }
  }, 5000);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function stopWatcher(files) {
  const record = watcherRecord(files);
  if (!record) return;
  if (!record.alive) {
    fs.unlinkSync(files.pid);
    return;
  }
  process.kill(record.pid, 'SIGTERM');
  for (let i = 0; i < 50; i++) {
    if (!watcherRecord(files)?.alive) return;
    await sleep(100);
  }
  throw new Error(`Helper ${record.pid} did not stop; no settings were restored.`);
}

async function launch(files) {
  if (desktopPids().length && !desktopPids(true).length) {
    throw new Error('Quit the standard Claude app before starting Claude 3P.');
  }
  ensureState(files);
  let record = watcherRecord(files);
  if (!record?.alive) {
    const token = crypto.randomBytes(16).toString('hex');
    const log = fs.openSync(files.log, fs.constants.O_WRONLY | fs.constants.O_CREAT |
      fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
    let child;
    try {
      child = cp.spawn(process.execPath, [__filename, 'watch', token], {
        stdio: ['ignore', log, log],
      });
    } finally {
      fs.closeSync(log);
    }
    let spawnError;
    child.on('error', error => { spawnError = error; });
    child.unref();
    for (let i = 0; i < 100; i++) {
      if (spawnError) throw spawnError;
      record = watcherRecord(files);
      if (record?.alive && record.ready) break;
      if (child.exitCode !== null) throw new Error(`Helper failed; see ${files.log}`);
      await sleep(100);
    }
    if (!record?.alive || !record.ready) throw new Error(`Helper did not become ready; see ${files.log}`);
  }
  if (record.initial?.errors.length) console.error(`Some settings were refused; inspect: ${files.log}`);
  cp.execFileSync('/usr/bin/open', [
    '-a', APP, '--env', 'CLAUDE_CODE_ATTRIBUTION_HEADER=0', '--args', '--3p',
  ]);
  console.log(`Claude 3P helper running (PID ${record.pid}). Auto-compact window: ` +
    `${OVERRIDES.CLAUDE_CODE_AUTO_COMPACT_WINDOW}. Stream idle timeout: ` +
    `${Number(OVERRIDES.CLAUDE_STREAM_IDLE_TIMEOUT_MS) / 1000}s.`);
  console.log('Run /context in Cowork: expect about 131.1k. A conversation already running may need restarting.');
  console.log(`Log: ${files.log}`);
}

async function main(args) {
  const files = locations();
  const command = args[0] ?? 'start';
  if (command === 'watch') return runWatcher(files, args[1]);
  if (command === 'start') return launch(files);
  if (command === 'status') {
    const record = watcherRecord(files);
    console.log(record?.alive ? `Running: PID ${record.pid}; ${SUMMARY}` : 'Helper is not running.');
    console.log(`Scope: ${files.root}\nLog: ${files.log}`);
    return;
  }
  if (command === 'stop' || command === 'restore') {
    await stopWatcher(files);
    if (command === 'restore') {
      const result = scan(files.root, restoreSession);
      result.errors.forEach(error => console.error(error));
      console.log(`Restored ${result.changed.length} session(s); preserved unrelated settings and later edits.`);
      if (result.errors.length) process.exitCode = 1;
    } else {
      console.log('Helper stopped. Applied compaction and stream-timeout settings remain; use "ccd restore" to undo them.');
    }
    return;
  }
  throw new Error('Usage: ccd [start|status|stop|restore]');
}

module.exports = { OVERRIDES, locations, configureSession, restoreSession, scan, startWatching };

if (require.main === module) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`ccd: ${error.message}`);
    process.exitCode = 1;
  });
}
