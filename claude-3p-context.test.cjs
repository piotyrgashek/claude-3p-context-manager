'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');

const script = path.join(__dirname, 'claude-3p-context.cjs');
const installer = path.join(__dirname, 'install.zsh');
const harness = path.join(__dirname, 'stream-timeout-harness.cjs');
const benchmark = path.join(__dirname, 'proxy-benchmark.cjs');
const http = require('node:http');
const net = require('node:net');
const {
  OVERRIDES, PERSISTENT_OVERRIDES, RETIRED_KEYS, proxyOverrides, locations, configureSession, restoreSession,
  releaseProxySession, scan, startWatching, startKeepAliveProxy,
} = require(script);
const cli = process.env.CLAUDE_3P_TEST_CLI;
// Spawned watchers must not take the real helper's proxy port.
const watcherEnv = home => ({ ...process.env, HOME: home, CCD_PROXY_PORT: '0' });

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccd-test-')));
  const home = path.join(base, 'home');
  const files = locations(home);
  fs.mkdirSync(files.root, { recursive: true });
  t.after(() => fs.rmSync(base, { recursive: true }));
  function session(id = '33333333') {
    const dir = path.join(files.root, '11111111', '22222222', id, '.claude');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  return { base, home, files, session };
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
}

function read(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Condition was not met within five seconds');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function install(f) {
  return cp.spawnSync('/bin/zsh', [installer], {
    env: { ...process.env, HOME: f.home },
    cwd: f.base,
    encoding: 'utf8',
    timeout: 10000,
  });
}

test('shouldPreserveUnrelatedSettingsAndRestoreOriginalValues', t => {
  // Given
  const f = fixture(t);
  const dir = f.session();
  const file = path.join(dir, 'settings.json');
  const original = {
    model: 'keep-this-model',
    env: { KEEP_THIS: 'unchanged', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000' },
    permissions: { allow: ['Read'] },
  };
  write(file, original);
  const mode = fs.statSync(file).mode;

  // When
  assert.equal(configureSession(f.files.root, dir), true);
  const configured = read(file);
  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(configureSession(f.files.root, dir), false);

  // Then
  assert.deepEqual(configured, { ...original, env: { ...original.env, ...OVERRIDES } });
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
  assert.equal(fs.statSync(file).mode, mode);
  assert.equal(fs.readFileSync(path.join(dir, '.ccd-context-backup.json'), 'utf8').includes('KEEP_THIS'), false);
  write(file, { ...configured, newUserPreference: true });
  assert.equal(restoreSession(f.files.root, dir), true);
  assert.deepEqual(read(file), { ...original, newUserPreference: true });
  assert.equal(fs.existsSync(path.join(dir, '.ccd-context-backup.json')), false);
});

test('shouldRemoveOnlyHelperCreatedSettingsWhenRestoring', t => {
  // Given
  const f = fixture(t);
  const dir = f.session();
  const file = path.join(dir, 'settings.json');

  // When
  configureSession(f.files.root, dir);
  restoreSession(f.files.root, dir);

  // Then
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(path.join(dir, '.ccd-context-backup.json')), false);
  assert.equal(fs.existsSync(dir), true);
});

test('shouldPreserveLaterUserChangesToManagedValues', t => {
  // Given
  const f = fixture(t);
  const dir = f.session();
  const file = path.join(dir, 'settings.json');
  configureSession(f.files.root, dir);
  write(file, { env: { ...OVERRIDES, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '110000' } });

  // When
  restoreSession(f.files.root, dir);

  // Then
  assert.deepEqual(read(file), { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '110000' } });
});

test('shouldExtendALegacyBackupWithNewlyManagedKeysAndRestoreThem', t => {
  // Given
  const f = fixture(t);
  const dir = f.session();
  const file = path.join(dir, 'settings.json');
  const backupFile = path.join(dir, '.ccd-context-backup.json');
  const legacy = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '131072', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '85' };
  write(file, { model: 'keep', env: { KEEP: 'yes', API_TIMEOUT_MS: '600000', ...legacy } });
  write(backupFile, {
    version: 1,
    settingsExisted: true,
    envExisted: true,
    original: {
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: { present: true, value: '200000' },
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: { present: false },
    },
    applied: legacy,
  });

  // When
  const changed = configureSession(f.files.root, dir);
  const configured = read(file);
  const backup = read(backupFile);
  const restored = restoreSession(f.files.root, dir);

  // Then
  assert.equal(changed, true);
  assert.deepEqual(configured, { model: 'keep', env: { KEEP: 'yes', API_TIMEOUT_MS: '600000', ...OVERRIDES } });
  assert.deepEqual(backup.applied, { ...OVERRIDES });
  assert.deepEqual(backup.original.CLAUDE_CODE_AUTO_COMPACT_WINDOW, { present: true, value: '200000' });
  assert.deepEqual(backup.original.CLAUDE_STREAM_IDLE_TIMEOUT_MS, { present: false });
  assert.deepEqual(backup.original.HTTP_PROXY, { present: false });
  assert.equal(Object.hasOwn(backup.original, 'API_TIMEOUT_MS'), false);
  assert.equal(restored, true);
  assert.deepEqual(read(file), {
    model: 'keep',
    env: { KEEP: 'yes', API_TIMEOUT_MS: '600000', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000' },
  });
  assert.equal(fs.existsSync(backupFile), false);
});

test('shouldRetireVersionTwoTimeoutKeysAndRestoreTheirOriginals', t => {
  // Given
  const f = fixture(t);
  const dir = f.session();
  const file = path.join(dir, 'settings.json');
  const backupFile = path.join(dir, '.ccd-context-backup.json');
  const version2 = {
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '131072',
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '85',
    API_FORCE_IDLE_TIMEOUT: '0',
    CLAUDE_STREAM_IDLE_TIMEOUT_MS: '1800000',
    API_TIMEOUT_MS: '2400000',
  };
  write(file, { env: { KEEP: 'yes', ...version2 } });
  write(backupFile, {
    version: 1,
    settingsExisted: true,
    envExisted: true,
    original: {
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: { present: false },
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: { present: false },
      API_FORCE_IDLE_TIMEOUT: { present: false },
      CLAUDE_STREAM_IDLE_TIMEOUT_MS: { present: false },
      API_TIMEOUT_MS: { present: true, value: '600000' },
    },
    applied: version2,
  });

  // When
  const changed = configureSession(f.files.root, dir);
  const configured = read(file);
  const backup = read(backupFile);
  restoreSession(f.files.root, dir);

  // Then
  assert.equal(changed, true);
  assert.deepEqual(configured, { env: { KEEP: 'yes', API_TIMEOUT_MS: '600000', ...OVERRIDES } });
  assert.deepEqual(Object.keys(backup.applied).sort(), Object.keys(OVERRIDES).sort());
  assert.deepEqual(Object.keys(backup.original).sort(), Object.keys(OVERRIDES).sort());
  RETIRED_KEYS.forEach(key => assert.equal(Object.hasOwn(backup.applied, key), false));
  assert.deepEqual(read(file), { env: { KEEP: 'yes', API_TIMEOUT_MS: '600000' } });
  assert.equal(fs.existsSync(backupFile), false);
});

test('shouldReleaseOnlyTheProxySettingAndKeepTheOthers', t => {
  // Given
  const f = fixture(t);
  const dir = f.session();
  const file = path.join(dir, 'settings.json');
  const backupFile = path.join(dir, '.ccd-context-backup.json');
  write(file, { env: { HTTP_PROXY: 'http://user-proxy.example:3128', KEEP: 'yes' } });
  configureSession(f.files.root, dir);

  // When
  const released = releaseProxySession(f.files.root, dir);
  const repeated = releaseProxySession(f.files.root, dir);

  // Then
  assert.equal(released, true);
  assert.equal(repeated, false);
  assert.deepEqual(read(file), { env: { HTTP_PROXY: 'http://user-proxy.example:3128', KEEP: 'yes', ...PERSISTENT_OVERRIDES } });
  assert.deepEqual(read(backupFile).applied, { ...PERSISTENT_OVERRIDES });
  assert.equal(Object.hasOwn(read(backupFile).original, 'HTTP_PROXY'), false);
  restoreSession(f.files.root, dir);
  assert.deepEqual(read(file), { env: { HTTP_PROXY: 'http://user-proxy.example:3128', KEEP: 'yes' } });
});

test('shouldFollowAProxyPortChangeAndStillRestoreTheOriginal', t => {
  // Given
  const f = fixture(t);
  const dir = f.session();
  const file = path.join(dir, 'settings.json');
  configureSession(f.files.root, dir, { ...PERSISTENT_OVERRIDES, ...proxyOverrides(40001) });

  // When
  const changed = configureSession(f.files.root, dir, { ...PERSISTENT_OVERRIDES, ...proxyOverrides(40002) });
  const configured = read(file);
  restoreSession(f.files.root, dir);

  // Then
  assert.equal(changed, true);
  assert.equal(configured.env.HTTP_PROXY, 'http://127.0.0.1:40002');
  assert.equal(fs.existsSync(file), false);
});

test('shouldRestoreOnlyTheKeysRecordedInALegacyBackup', t => {
  // Given
  const f = fixture(t);
  const dir = f.session();
  const file = path.join(dir, 'settings.json');
  write(file, {
    env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '131072', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '85', API_TIMEOUT_MS: '2400000' },
  });
  write(path.join(dir, '.ccd-context-backup.json'), {
    version: 1,
    settingsExisted: true,
    envExisted: true,
    original: {
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: { present: false },
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: { present: false },
    },
    applied: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '131072', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '85' },
  });

  // When
  const restored = restoreSession(f.files.root, dir);

  // Then
  assert.equal(restored, true);
  assert.deepEqual(read(file), { env: { API_TIMEOUT_MS: '2400000' } });
});

test('shouldRefuseBackupsThatRecordUnmanagedOrNoKeys', t => {
  // Given
  const f = fixture(t);
  const base = { version: 1, settingsExisted: false, envExisted: false };
  const invalid = [
    { ...base, original: {}, applied: {} },
    { ...base, original: { PATH: { present: false } }, applied: { PATH: '/tmp' } },
    { ...base, original: { API_TIMEOUT_MS: { present: false } }, applied: { API_TIMEOUT_MS: 2400000 } },
    { ...base, original: {}, applied: { API_TIMEOUT_MS: '2400000' } },
  ];

  // When / Then
  invalid.forEach((backup, index) => {
    const dir = f.session((index + 1).toString(16).padStart(8, '0'));
    const backupFile = path.join(dir, '.ccd-context-backup.json');
    write(backupFile, backup);
    const raw = fs.readFileSync(backupFile, 'utf8');
    assert.throws(() => configureSession(f.files.root, dir), /Unrecognized backup/);
    assert.throws(() => restoreSession(f.files.root, dir), /Unrecognized backup/);
    assert.equal(fs.readFileSync(backupFile, 'utf8'), raw);
    assert.equal(fs.existsSync(path.join(dir, 'settings.json')), false);
  });
});

test('shouldRefuseInvalidSettingsWithoutOverwritingThem', t => {
  // Given
  const f = fixture(t);
  const invalid = ['{', '[]', 'null', '{"env":[]}', '{"env":null}', '{"env":"not an object"}'];

  // When / Then
  invalid.forEach((raw, index) => {
    const dir = f.session((index + 1).toString(16).padStart(8, '0'));
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, raw);
    assert.throws(() => configureSession(f.files.root, dir), /JSON|object/);
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
    assert.equal(fs.existsSync(path.join(dir, '.ccd-context-backup.json')), false);
  });
});

test('shouldRefuseSymlinksAndOutOfScopePaths', t => {
  // Given
  const f = fixture(t);
  const cliDir = path.join(f.home, '.claude');
  const cliFile = path.join(cliDir, 'settings.json');
  write(cliFile, { model: 'terminal-must-not-change' });
  const dir = f.session();
  fs.symlinkSync(cliFile, path.join(dir, 'settings.json'));
  const second = f.session('44444444');
  fs.rmdirSync(second);
  fs.symlinkSync(cliDir, second);
  fs.symlinkSync(cliDir, path.join(f.files.root, 'aaaaaaaa'));

  // When / Then
  assert.throws(() => configureSession(f.files.root, dir), /symlinks/);
  assert.throws(() => configureSession(f.files.root, second), /symlinks/);
  assert.throws(() => configureSession(f.files.root, cliDir), /outside/);
  assert.equal(scan(f.files.root).errors.length, 3);
  assert.deepEqual(read(cliFile), { model: 'terminal-must-not-change' });
  assert.equal(fs.existsSync(path.join(cliDir, '.ccd-context-backup.json')), false);
});

test('shouldTouchOnlyRealCoworkSessionSettings', t => {
  // Given
  const f = fixture(t);
  const dir = f.session();
  const unrelated = [
    path.join(f.home, '.claude/settings.json'),
    path.join(f.home, 'Library/Application Support/Claude/settings.json'),
    path.join(f.files.root, 'plugin-command/11111111/22222222/.claude/settings.json'),
    path.join(path.dirname(dir), 'mnt/workspace/.claude/settings.json'),
  ];
  unrelated.forEach(file => write(file, { preserve: file }));

  // When
  const result = scan(f.files.root);

  // Then
  assert.equal(result.sessions, 1);
  assert.equal(result.changed.length, 1);
  assert.deepEqual(result.errors, []);
  unrelated.forEach(file => assert.deepEqual(read(file), { preserve: file }));
  assert.deepEqual(read(path.join(dir, 'settings.json')), { env: OVERRIDES });
});

test('shouldReportMalformedSettingsAndContinueWithHealthySessions', t => {
  // Given
  const f = fixture(t);
  const broken = f.session('33333333');
  const healthy = f.session('44444444');
  fs.writeFileSync(path.join(broken, 'settings.json'), '{invalid');

  // When
  const result = scan(f.files.root);

  // Then
  assert.equal(result.errors.length, 1);
  assert.equal(result.changed.length, 1);
  assert.equal(fs.readFileSync(path.join(broken, 'settings.json'), 'utf8'), '{invalid');
  assert.deepEqual(read(path.join(healthy, 'settings.json')), { env: OVERRIDES });
});

test('shouldConfigureNewSessionsAndReapplyOnlyOwnedKeysWhileWatching', async t => {
  // Given
  const f = fixture(t);
  const messages = [];
  const watcher = startWatching(f.files.root, message => messages.push(message), 50);
  try {
    assert.equal(watcher.initial.sessions, 0);

    // When
    const dir = f.session();
    const file = path.join(dir, 'settings.json');
    await waitFor(() => fs.existsSync(file));
    write(file, { env: { ...OVERRIDES, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000', KEEP: 'yes' } });
    await waitFor(() => read(file).env.CLAUDE_CODE_AUTO_COMPACT_WINDOW === '131072');

    // Then
    assert.deepEqual(read(file).env, { ...OVERRIDES, KEEP: 'yes' });
    assert.ok(messages.some(message => message.startsWith('Configured ')));
    assert.equal(fs.readdirSync(dir).some(name => name.endsWith('.tmp')), false);
  } finally {
    watcher.close();
  }
});

test('shouldShowTheSmallerWindowInTheActualEmbeddedCli', {
  skip: cli ? false : 'Set CLAUDE_3P_TEST_CLI to the Desktop embedded CLI to run this offline probe.',
}, t => {
  // Given
  const f = fixture(t);
  const dir = f.session();
  configureSession(f.files.root, dir, PERSISTENT_OVERRIDES);
  const env = {
    ...process.env,
    HOME: f.home,
    CLAUDE_CONFIG_DIR: dir,
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    ANTHROPIC_AUTH_TOKEN: 'offline-probe',
    ANTHROPIC_API_KEY: '',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    API_TIMEOUT_MS: '5000',
    CLAUDE_CODE_MAX_RETRIES: '0',
  };
  for (const key of [...Object.keys(OVERRIDES), 'CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'DISABLE_COMPACT', 'DISABLE_AUTO_COMPACT']) {
    delete env[key];
  }

  // When / Then
  for (const model of ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-sonnet-5']) {
    const result = cp.spawnSync(cli, [
      '--print', '/context', '--model', model, '--setting-sources', 'user',
      '--no-session-persistence', '--tools', '',
    ], { cwd: f.base, env, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\/ 131\.1k/);
    assert.match(result.stdout, /Autocompact buffer.*33k/);
  }
});

test('shouldRunTheStreamTimeoutHarnessAgainstTheActualEmbeddedCli', {
  skip: cli ? false : 'Set CLAUDE_3P_TEST_CLI to the Desktop embedded CLI to run this offline probe.',
}, () => {
  // Given
  const args = [harness, '--cli', cli, '--silence-seconds', '3', '--ping-seconds', '1', '--scenarios', 'control,fix'];

  // When
  const result = cp.spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 90000 });

  // Then
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^control\s+SURVIVED/m);
  assert.match(result.stdout, /^fix\s+SURVIVED.*proxy sent [1-9]\d* ping/m);
  assert.match(result.stdout, /^OK: ccd settings and keep-alive proxy/m);
});

test('shouldMeasureProxyOverheadWithTheBenchmark', t => {
  // Given
  const f = fixture(t);
  configureSession(f.files.root, f.session(), PERSISTENT_OVERRIDES);

  // When
  const result = cp.spawnSync(process.execPath, [benchmark, '--quick'], {
    env: { ...process.env, HOME: f.home }, encoding: 'utf8', timeout: 60000,
  });

  // Then
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^Small request round trip, median\s+[\d.]+ ms\s+[\d.]+ ms\s+[+-][\d.]+ ms$/m);
  assert.match(result.stdout, /MB event burst, median throughput\s+\d+ MB\/s\s+\d+ MB\/s/);
  assert.match(result.stdout, /^Watcher sweep of 1 conversation\(s\)/m);
});

test('shouldStartOnlyOneWatcherAndStopOnlyItsOwnProcess', async t => {
  // Given
  const f = fixture(t);
  const dir = f.session();
  const file = path.join(dir, 'settings.json');
  const token = crypto.randomBytes(16).toString('hex');
  const env = watcherEnv(f.home);
  const target = http.createServer((req, res) => res.end(`reached ${req.url}`));
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  t.after(() => target.close());
  const child = cp.spawn(process.execPath, [script, 'watch', token], { env, stdio: 'ignore' });
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    await waitFor(() => fs.existsSync(f.files.pid) && read(f.files.pid).ready === true);
    const proxyPort = read(f.files.pid).proxyPort;
    const routed = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: proxyPort, path: `http://127.0.0.1:${target.address().port}/probe` }, res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve(body));
      }).on('error', reject);
    });

    // When
    const duplicate = cp.spawnSync(process.execPath, [script, 'watch', crypto.randomBytes(16).toString('hex')], {
      env, encoding: 'utf8', timeout: 5000,
    });
    const status = cp.spawnSync(process.execPath, [script, 'status'], { env, encoding: 'utf8', timeout: 5000 });
    const configured = read(file);
    const stop = cp.spawnSync(process.execPath, [script, 'stop'], { env, encoding: 'utf8', timeout: 10000 });

    // Then
    assert.equal(routed, 'reached /probe');
    assert.equal(duplicate.status, 0, duplicate.stderr);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, new RegExp(`PID ${child.pid}; window=131072; stream idle timeout=1800s; ` +
      `keep-alive proxy=http://127\\.0\\.0\\.1:${proxyPort}`));
    assert.deepEqual(configured, { env: { ...PERSISTENT_OVERRIDES, ...proxyOverrides(proxyPort) } });
    assert.equal(stop.status, 0, stop.stderr);
    await exited;
    assert.equal(fs.existsSync(f.files.pid), false);
    assert.deepEqual(read(file), { env: { ...PERSISTENT_OVERRIDES } });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await exited;
    }
  }
});

test('shouldRemoveAStaleProxySettingWhenTheProxyCannotStart', async t => {
  // Given
  const f = fixture(t);
  const dir = f.session();
  const file = path.join(dir, 'settings.json');
  const busy = net.createServer();
  await new Promise(resolve => busy.listen(0, '127.0.0.1', resolve));
  t.after(() => busy.close());
  configureSession(f.files.root, dir, { ...PERSISTENT_OVERRIDES, ...proxyOverrides(busy.address().port) });
  const env = { ...watcherEnv(f.home), CCD_PROXY_PORT: String(busy.address().port) };
  const warning = cp.spawnSync(process.execPath, [script, 'status'], { env, encoding: 'utf8', timeout: 5000 });

  // When
  const result = cp.spawnSync(process.execPath, [script, 'watch', crypto.randomBytes(16).toString('hex')], {
    env, encoding: 'utf8', timeout: 10000,
  });

  // Then
  assert.match(warning.stdout, /1 conversation\(s\) still route through the stopped keep-alive proxy/);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /keep-alive proxy could not start/);
  assert.match(result.stdout, /Removed the keep-alive proxy from 1 conversation\(s\)/);
  assert.deepEqual(read(file), { env: { ...PERSISTENT_OVERRIDES } });
  assert.equal(fs.existsSync(f.files.pid), false);
});

test('shouldPingSilentEventStreamsOnlyBetweenEvents', async t => {
  // Given
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const upstream = http.createServer(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: first\ndata: 1\n\n');
    await pause(300);
    res.write('event: second\ndata: ');
    await pause(300);
    res.write('2\n\n');
    await pause(300);
    res.end('event: last\ndata: 3\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = await startKeepAliveProxy({ port: 0, pingIntervalMs: 50 });
  t.after(async () => { await proxy.close(); upstream.close(); });

  // When
  const body = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: proxy.port, path: `http://127.0.0.1:${upstream.address().port}/v1/messages` }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve(text));
    }).on('error', reject);
  });

  // Then
  const ping = 'event: ping\ndata: {"type": "ping"}\n\n';
  assert.ok(proxy.stats.pings >= 4, `expected pings, got ${proxy.stats.pings}`);
  assert.equal(body.split(ping).join(''), 'event: first\ndata: 1\n\nevent: second\ndata: 2\n\nevent: last\ndata: 3\n\n');
  assert.match(body, /^event: first\ndata: 1\n\n(event: ping\ndata: \{"type": "ping"\}\n\n)+event: second\ndata: 2\n\n/);
});

test('shouldRelayOtherResponsesUnchangedAndRejectNonProxyRequests', async t => {
  // Given
  const upstream = http.createServer((req, res) => {
    setTimeout(() => res.writeHead(201, { 'content-type': 'application/json' }).end('{"ok":true}'), 200);
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = await startKeepAliveProxy({ port: 0, pingIntervalMs: 20 });
  t.after(async () => { await proxy.close(); upstream.close(); });
  const get = requestPath => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: proxy.port, path: requestPath }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    }).on('error', reject);
  });

  // When
  const relayed = await get(`http://127.0.0.1:${upstream.address().port}/json`);
  const direct = await get('/not-a-proxy-request');

  // Then
  assert.deepEqual(relayed, { status: 201, text: '{"ok":true}' });
  assert.equal(direct.status, 400);
  assert.equal(proxy.stats.pings, 0);
});

test('shouldTunnelConnectRequestsAndCancelUpstreamWhenTheClientLeaves', async t => {
  // Given
  const echo = net.createServer(socket => socket.pipe(socket));
  await new Promise(resolve => echo.listen(0, '127.0.0.1', resolve));
  let upstreamClosed;
  const closed = new Promise(resolve => { upstreamClosed = resolve; });
  const stream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: start\ndata: 0\n\n');
    res.on('close', upstreamClosed);
  });
  await new Promise(resolve => stream.listen(0, '127.0.0.1', resolve));
  const proxy = await startKeepAliveProxy({ port: 0, pingIntervalMs: 50 });
  t.after(async () => { await proxy.close(); echo.close(); stream.close(); });

  // When
  const echoed = await new Promise((resolve, reject) => {
    const socket = net.connect(proxy.port, '127.0.0.1', () => {
      socket.write(`CONNECT 127.0.0.1:${echo.address().port} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);
    });
    let text = '';
    socket.on('data', chunk => {
      text += chunk;
      if (text.endsWith('\r\n\r\n') && !text.includes('hello')) socket.write('hello');
      if (text.endsWith('hello')) {
        socket.end();
        resolve(text);
      }
    });
    socket.on('error', reject);
  });
  await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: proxy.port, path: `http://127.0.0.1:${stream.address().port}/v1/messages` }, res => {
      res.once('data', () => {
        req.destroy();
        resolve();
      });
    });
    req.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
  });

  // Then
  assert.match(echoed, /^HTTP\/1\.1 200 Connection Established\r\n\r\nhello$/);
  await closed;
});

test('shouldInstallPortablyWithoutEditingSettingsOrStartingClaude', t => {
  // Given
  const f = fixture(t);
  const untouched = [
    path.join(f.home, '.zshrc'),
    path.join(f.home, '.claude/settings.json'),
    path.join(f.home, '.ollama/config.json'),
  ];
  untouched.forEach(file => write(file, { preserve: file }));

  // When
  const result = install(f);

  // Then
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const bin = path.join(f.home, '.local/bin');
  for (const name of ['claude-3p-context.cjs', 'ccd.zsh']) {
    assert.equal(fs.readFileSync(path.join(bin, name), 'utf8'), fs.readFileSync(path.join(__dirname, name), 'utf8'));
    assert.equal(fs.statSync(path.join(bin, name)).mode & 0o777, 0o600);
  }
  untouched.forEach(file => assert.deepEqual(read(file), { preserve: file }));
  assert.equal(fs.existsSync(f.files.state), false);
  const binding = cp.spawnSync('/bin/zsh', ['-f', '-c', 'alias ccd=false; source "$1"; ccd status', 'zsh', path.join(bin, 'ccd.zsh')], {
    env: { ...process.env, HOME: f.home }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(binding.status, 0, binding.stderr);
  assert.match(binding.stdout, /Helper is not running/);
});

test('shouldInstallIdempotentlyAndBackUpChangedScripts', t => {
  // Given
  const f = fixture(t);
  const bin = path.join(f.home, '.local/bin');
  assert.equal(install(f).status, 0);
  const helper = path.join(bin, 'claude-3p-context.cjs');
  const modified = fs.readFileSync(helper, 'utf8') + '\n// Existing local customization.\n';
  fs.writeFileSync(helper, modified);

  // When
  const result = install(f);
  const repeated = install(f);

  // Then
  assert.equal(result.status, 0, result.stderr);
  assert.equal(repeated.status, 0, repeated.stderr);
  const backups = fs.readdirSync(bin).filter(name => name.startsWith('claude-3p-context.cjs.backup.'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(bin, backups[0]), 'utf8'), modified);
  assert.equal(fs.readFileSync(helper, 'utf8'), fs.readFileSync(script, 'utf8'));
});

test('shouldRefuseInstallationOverASymlink', t => {
  // Given
  const f = fixture(t);
  const bin = path.join(f.home, '.local/bin');
  fs.mkdirSync(bin, { recursive: true });
  const outside = path.join(f.base, 'untouched');
  fs.writeFileSync(outside, 'preserve');
  fs.symlinkSync(outside, path.join(bin, 'ccd.zsh'));

  // When
  const result = install(f);

  // Then
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing symlink/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'preserve');
  assert.equal(fs.existsSync(path.join(bin, 'claude-3p-context.cjs')), false);
});

test('shouldRefuseToOverwriteARunningInstalledHelper', async t => {
  // Given
  const f = fixture(t);
  assert.equal(install(f).status, 0);
  const installed = path.join(f.home, '.local/bin/claude-3p-context.cjs');
  const env = watcherEnv(f.home);
  const child = cp.spawn(process.execPath, [installed, 'watch', crypto.randomBytes(16).toString('hex')], {
    env, stdio: 'ignore',
  });
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    await waitFor(() => fs.existsSync(f.files.pid) && read(f.files.pid).ready === true);

    // When
    const result = install(f);

    // Then
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /helper is running/);
    assert.equal(read(f.files.pid).pid, child.pid);
    assert.equal(fs.readFileSync(installed, 'utf8'), fs.readFileSync(script, 'utf8'));
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await exited;
    }
  }
});
