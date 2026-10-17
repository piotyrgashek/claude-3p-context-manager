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
const { OVERRIDES, locations, configureSession, restoreSession, scan, startWatching } = require(script);
const cli = process.env.CLAUDE_3P_TEST_CLI;

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
  assert.deepEqual(configured, { model: 'keep', env: { KEEP: 'yes', ...OVERRIDES } });
  assert.deepEqual(backup.applied, { ...OVERRIDES });
  assert.deepEqual(backup.original.CLAUDE_CODE_AUTO_COMPACT_WINDOW, { present: true, value: '200000' });
  assert.deepEqual(backup.original.API_TIMEOUT_MS, { present: true, value: '600000' });
  assert.deepEqual(backup.original.API_FORCE_IDLE_TIMEOUT, { present: false });
  assert.deepEqual(backup.original.CLAUDE_STREAM_IDLE_TIMEOUT_MS, { present: false });
  assert.equal(restored, true);
  assert.deepEqual(read(file), {
    model: 'keep',
    env: { KEEP: 'yes', API_TIMEOUT_MS: '600000', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000' },
  });
  assert.equal(fs.existsSync(backupFile), false);
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
  configureSession(f.files.root, dir);
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
  const args = [harness, '--cli', cli, '--silence-seconds', '3', '--scenarios', 'control,fix'];

  // When
  const result = cp.spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 90000 });

  // Then
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^control\s+SURVIVED/m);
  assert.match(result.stdout, /^fix\s+SURVIVED/m);
  assert.match(result.stdout, /^OK: the settings written by ccd/m);
});

test('shouldStartOnlyOneWatcherAndStopOnlyItsOwnProcess', async t => {
  // Given
  const f = fixture(t);
  const token = crypto.randomBytes(16).toString('hex');
  const env = { ...process.env, HOME: f.home };
  const child = cp.spawn(process.execPath, [script, 'watch', token], { env, stdio: 'ignore' });
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    await waitFor(() => fs.existsSync(f.files.pid) && read(f.files.pid).ready === true);

    // When
    const duplicate = cp.spawnSync(process.execPath, [script, 'watch', crypto.randomBytes(16).toString('hex')], {
      env, encoding: 'utf8', timeout: 5000,
    });
    const status = cp.spawnSync(process.execPath, [script, 'status'], { env, encoding: 'utf8', timeout: 5000 });
    const stop = cp.spawnSync(process.execPath, [script, 'stop'], { env, encoding: 'utf8', timeout: 10000 });

    // Then
    assert.equal(duplicate.status, 0, duplicate.stderr);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, new RegExp(`PID ${child.pid}; window=131072; stream idle timeout=1800s`));
    assert.equal(stop.status, 0, stop.stderr);
    await exited;
    assert.equal(fs.existsSync(f.files.pid), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await exited;
    }
  }
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
  const env = { ...process.env, HOME: f.home };
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
