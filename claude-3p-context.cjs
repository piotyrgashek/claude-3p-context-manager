'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const http = require('node:http');
const net = require('node:net');

// Applied to every conversation and kept after the helper stops.
const PERSISTENT_OVERRIDES = Object.freeze({
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: '131072',
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '85',
  CLAUDE_STREAM_IDLE_TIMEOUT_MS: '1800000',
});
// Version 2 managed these, but Desktop launches every Cowork CLI with its own values and the CLI
// lets the launch environment win over settings files. Upgrades restore their original values.
const RETIRED_KEYS = Object.freeze(['API_FORCE_IDLE_TIMEOUT', 'API_TIMEOUT_MS']);
const PROXY_HOST = '127.0.0.1';
const DEFAULT_PROXY_PORT = 11535;
const PING_INTERVAL_MS = 15000;
const proxyOverrides = port => Object.freeze({ HTTP_PROXY: `http://${PROXY_HOST}:${port}` });
// Applied only while the helper, and therefore its keep-alive proxy, is running.
const OVERRIDES = Object.freeze({ ...PERSISTENT_OVERRIDES, ...proxyOverrides(DEFAULT_PROXY_PORT) });
const PROXY_KEYS = new Set(Object.keys(proxyOverrides(DEFAULT_PROXY_PORT)));
const MANAGED_KEYS = new Set([...Object.keys(OVERRIDES), ...RETIRED_KEYS]);
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
  const recorded = value.applied && typeof value.applied === 'object' && !Array.isArray(value.applied)
    ? Object.keys(value.applied) : [];
  if (value.version !== 1 || typeof value.settingsExisted !== 'boolean' ||
      typeof value.envExisted !== 'boolean' ||
      !value.original || typeof value.original !== 'object' || recorded.length === 0 ||
      !recorded.every(key =>
        MANAGED_KEYS.has(key) &&
        typeof value.original[key]?.present === 'boolean' &&
        typeof value.applied[key] === 'string')) {
    throw new ConfigError(`Unrecognized backup; left untouched: ${file}`);
  }
  return record;
}

function pick(object, keys) {
  return Object.fromEntries(keys.filter(key => Object.hasOwn(object, key)).map(key => [key, object[key]]));
}

function removeFile(file, previous) {
  if (readObject(file)?.raw !== previous.raw) throw new ConfigError(`File changed during update; will retry: ${file}`);
  fs.unlinkSync(file);
}

// Makes the helper-managed variables of one conversation exactly `desired`: records originals before
// applying new keys, and restores recorded keys that are no longer wanted unless the user changed them.
function reconcileSession(root, dir, desired) {
  managedDirectory(root, dir);
  const file = path.join(dir, 'settings.json');
  const backupFile = path.join(dir, BACKUP_NAME);
  const previous = readObject(file);
  const settings = previous?.value ?? {};
  const current = settingsEnv(settings, file);
  const backup = readBackup(backupFile);
  const recorded = backup?.value ?? {
    version: 1,
    settingsExisted: previous !== undefined,
    envExisted: Object.hasOwn(settings, 'env'),
    original: {},
    applied: {},
  };
  const release = Object.keys(recorded.applied).filter(key => !Object.hasOwn(desired, key));
  if (release.length === 0 && Object.entries(desired).every(([key, value]) =>
    current[key] === value && (!Object.hasOwn(recorded.applied, key) || recorded.applied[key] === value))) {
    return false;
  }

  const env = { ...current };
  const next = { ...recorded, original: { ...recorded.original }, applied: { ...recorded.applied } };
  for (const key of release) {
    // Keep a value the user changed after the helper applied it.
    if (env[key] === next.applied[key]) {
      if (next.original[key].present) env[key] = next.original[key].value;
      else delete env[key];
    }
    delete next.original[key];
    delete next.applied[key];
  }
  let grows = false;
  for (const [key, value] of Object.entries(desired)) {
    if (!Object.hasOwn(next.applied, key)) {
      next.original[key] = Object.hasOwn(env, key) ? { present: true, value: env[key] } : { present: false };
    }
    grows ||= next.applied[key] !== value;
    next.applied[key] = value;
    env[key] = value;
  }
  const emptied = Object.keys(next.applied).length === 0;
  const nextSettings = { ...settings, env };
  if (emptied && !next.envExisted && Object.keys(env).length === 0) delete nextSettings.env;

  // Record new keys before changing settings and forget released ones only afterwards, so an
  // interruption never leaves a helper-applied value without its original.
  let backupState = backup;
  if (grows) {
    writeObject(backupFile, {
      ...next,
      original: { ...pick(recorded.original, release), ...next.original },
      applied: { ...pick(recorded.applied, release), ...next.applied },
    }, backupState);
    backupState = readObject(backupFile);
  }
  if (emptied && !next.settingsExisted && Object.keys(nextSettings).length === 0) {
    if (previous) removeFile(file, previous);
  } else if (previous || !emptied) {
    writeObject(file, nextSettings, previous);
  }
  if (emptied) {
    if (backupState) removeFile(backupFile, backupState);
  } else if (release.length) {
    writeObject(backupFile, next, backupState);
  }
  return true;
}

function configureSession(root, dir, desired = OVERRIDES) {
  return reconcileSession(root, dir, desired);
}

function restoreSession(root, dir) {
  return reconcileSession(root, dir, {});
}

// Stops routing a conversation through the keep-alive proxy and drops retired keys, leaving the
// other recorded settings as they are.
function releaseProxySession(root, dir) {
  managedDirectory(root, dir);
  const backup = readBackup(path.join(dir, BACKUP_NAME));
  if (!backup) return false;
  const keep = Object.entries(backup.value.applied)
    .filter(([key]) => !PROXY_KEYS.has(key) && !RETIRED_KEYS.includes(key));
  if (keep.length === Object.keys(backup.value.applied).length) return false;
  return reconcileSession(root, dir, Object.fromEntries(keep));
}

function referencesProxy(root, dir) {
  managedDirectory(root, dir);
  const applied = readBackup(path.join(dir, BACKUP_NAME))?.value.applied ?? {};
  const env = readObject(path.join(dir, 'settings.json'))?.value.env ?? {};
  return [...PROXY_KEYS].some(key => Object.hasOwn(applied, key) && env[key] === applied[key]);
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

function startWatching(root, report, intervalMs = 2000, desired = OVERRIDES) {
  let debounce;
  let stopped = false;
  const seenErrors = new Set();
  const configure = (base, dir) => configureSession(base, dir, desired);
  function sweep() {
    if (stopped) return;
    const result = scan(root, configure);
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

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const PING = 'event: ping\ndata: {"type": "ping"}\n\n';

function endToEndHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP_BY_HOP.has(name.toLowerCase())));
}

function endsEvent(tail) {
  return tail.endsWith('\n\n') || tail.endsWith('\r\r') || tail.endsWith('\r\n\r\n');
}

// A local HTTP forward proxy for the Desktop-embedded CLI. Ollama sends no bytes while it generates a
// tool call, and Desktop's forced idle timeout abandons a connection after about five minutes of
// silence, so Server-Sent Events responses get a "ping" event (which the CLI ignores) between events
// whenever upstream has been silent for pingIntervalMs. Other traffic is relayed unchanged.
function startKeepAliveProxy({
  port = DEFAULT_PROXY_PORT, host = PROXY_HOST, pingIntervalMs = PING_INTERVAL_MS, log = () => {},
} = {}) {
  const agent = new http.Agent({ keepAlive: true });
  const stats = { requests: 0, streams: 0, pings: 0, tunnels: 0 };

  function relayEvents(response, res, finish) {
    stats.streams++;
    res.flushHeaders();
    let tail = '';
    let boundary = true;
    let lastUpstream = Date.now();
    let lastWrite = lastUpstream;
    let longest = 0;
    let pings = 0;
    const tick = setInterval(() => {
      const now = Date.now();
      if (!boundary || now - lastWrite < pingIntervalMs || res.writableEnded || res.writableLength > 0) return;
      res.write(PING);
      lastWrite = now;
      pings++;
      stats.pings++;
    }, Math.max(10, Math.min(1000, Math.floor(pingIntervalMs / 4))));
    response.on('data', chunk => {
      const now = Date.now();
      longest = Math.max(longest, now - lastUpstream);
      lastUpstream = lastWrite = now;
      tail = (tail + chunk.toString('latin1')).slice(-4);
      boundary = endsEvent(tail);
      if (!res.write(chunk)) {
        response.pause();
        res.once('drain', () => response.resume());
      }
    });
    response.on('end', () => {
      clearInterval(tick);
      finish();
      res.end();
      if (pings) {
        longest = Math.max(longest, Date.now() - lastUpstream);
        log(`Keep-alive proxy: sent ${pings} ping(s) during ${Math.round(longest / 1000)}s of upstream silence.`);
      }
    });
    response.on('close', () => {
      clearInterval(tick);
      if (!response.complete) res.destroy();
    });
    res.on('close', () => clearInterval(tick));
  }

  function forward(req, res) {
    let target;
    try {
      target = new URL(req.url);
    } catch {
      target = undefined;
    }
    if (target?.protocol !== 'http:' || !target.hostname) {
      // Origin-form requests come from clients that were not configured to use a proxy.
      req.resume();
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
      res.end('This is the ccd keep-alive proxy. It only accepts proxy requests.\n');
      return;
    }
    stats.requests++;
    let finished = false;
    const finish = () => { finished = true; };
    const upstream = http.request({
      hostname: target.hostname.replace(/^\[|\]$/g, ''),
      port: target.port || 80,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers: endToEndHeaders(req.headers),
      agent,
    });
    // A client that gives up must also stop the upstream generation.
    res.on('close', () => { if (!finished) upstream.destroy(); });
    upstream.on('error', error => {
      if (finished) return;
      finished = true;
      log(`Keep-alive proxy: ${req.method} ${target.host}${target.pathname} failed: ${error.message}`);
      if (res.headersSent) {
        res.destroy(error);
      } else {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`ccd keep-alive proxy could not reach ${target.host}: ${error.message}\n`);
      }
    });
    upstream.on('response', response => {
      const headers = endToEndHeaders(response.headers);
      const type = String(response.headers['content-type'] ?? '');
      const encoding = String(response.headers['content-encoding'] ?? 'identity').toLowerCase();
      const events = response.statusCode === 200 && /^text\/event-stream\b/i.test(type) && encoding === 'identity';
      if (events) delete headers['content-length'];
      res.writeHead(response.statusCode, response.statusMessage, headers);
      if (events) {
        relayEvents(response, res, finish);
        return;
      }
      response.on('end', finish);
      response.on('close', () => { if (!response.complete) res.destroy(); });
      response.pipe(res);
    });
    req.pipe(upstream);
  }

  const server = http.createServer({ requestTimeout: 0 }, forward);
  server.on('connect', (req, socket, head) => {
    const match = /^(\[[^\]]+\]|[^:[\]]+):(\d{1,5})$/.exec(req.url ?? '');
    if (!match) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    stats.tunnels++;
    let connected = false;
    const upstream = net.connect({ host: match[1].replace(/^\[|\]$/g, ''), port: Number(match[2]) }, () => {
      connected = true;
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => {
      if (!connected && socket.writable) socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      else socket.destroy();
    });
    upstream.on('close', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  });
  server.on('clientError', (error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    else socket.destroy();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      server.on('error', error => log(`Keep-alive proxy error: ${error.message}`));
      const actual = server.address().port;
      resolve({
        port: actual,
        url: `http://${host}:${actual}`,
        stats,
        close: () => new Promise(done => {
          server.close(() => done());
          server.closeAllConnections();
          agent.destroy();
        }),
      });
    });
  });
}

function configuredProxyPort(env = process.env) {
  const raw = env.CCD_PROXY_PORT;
  if (raw === undefined || raw === '') return DEFAULT_PROXY_PORT;
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port > 65535) throw new Error(`Invalid CCD_PROXY_PORT: ${raw}`);
  return port;
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

function releaseProxySettings(files, log) {
  if (!stat(files.root)) return;
  const result = scan(files.root, releaseProxySession);
  if (result.changed.length) log(`Removed the keep-alive proxy from ${result.changed.length} conversation(s).`);
  result.errors.forEach(error => log(`ERROR: ${error}`));
}

async function runWatcher(files, token) {
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
    // Conversations must not keep pointing at a proxy that is about to disappear.
    releaseProxySettings(files, log);
    if (readObject(files.pid)?.value.token === token) fs.unlinkSync(files.pid);
  }
  process.once('exit', cleanup);
  process.once('SIGTERM', () => process.exit(0));
  process.once('SIGINT', () => process.exit(0));
  let proxy;
  try {
    proxy = await startKeepAliveProxy({ port: configuredProxyPort(), log });
  } catch (error) {
    log(`ERROR: the keep-alive proxy could not start: ${error.message}`);
    process.exit(1);
  }
  watcher = startWatching(files.root, log, 2000, { ...PERSISTENT_OVERRIDES, ...proxyOverrides(proxy.port) });
  writeObject(files.pid, { ...owner, ready: true, proxyPort: proxy.port, initial: watcher.initial },
    readObject(files.pid));
  log(`Watching only ${files.root}; ${SUMMARY}; keep-alive proxy=${proxy.url}; ` +
    `initial errors=${watcher.initial.errors.length}`);
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
  console.log(`Keep-alive proxy: http://${PROXY_HOST}:${record.proxyPort} ` +
    `(pings silent streams every ${PING_INTERVAL_MS / 1000}s).`);
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
    if (record?.alive) {
      console.log(`Running: PID ${record.pid}; ${SUMMARY}; keep-alive proxy=http://${PROXY_HOST}:${record.proxyPort}`);
    } else {
      console.log('Helper is not running.');
      const stale = stat(files.root) ? scan(files.root, referencesProxy).changed.length : 0;
      if (stale) {
        console.log(`Warning: ${stale} conversation(s) still route through the stopped keep-alive proxy. ` +
          'Run "ccd" to restart it or "ccd stop" to remove the setting.');
      }
    }
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
      // A helper that crashed could not remove its proxy setting itself.
      releaseProxySettings(files, message => console.log(message));
      console.log('Helper stopped; the keep-alive proxy is off and no conversation uses it. Compaction and ' +
        'stream-idle settings remain; use "ccd restore" to undo them.');
    }
    return;
  }
  throw new Error('Usage: ccd [start|status|stop|restore]');
}

module.exports = {
  OVERRIDES, PERSISTENT_OVERRIDES, RETIRED_KEYS, PING_INTERVAL_MS, proxyOverrides, locations,
  configureSession, restoreSession, releaseProxySession, scan, startWatching, startKeepAliveProxy,
};

if (require.main === module) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`ccd: ${error.message}`);
    process.exitCode = 1;
  });
}
