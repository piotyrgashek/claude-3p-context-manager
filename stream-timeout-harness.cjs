#!/usr/bin/env node
'use strict';

// Offline reproduction of the Claude Desktop 3P "Your response above was cut off mid-stream" loop and
// "API Error: The operation timed out." failures. A fake Anthropic endpoint sends the first SSE events
// and then stays byte-silent, as Ollama does while it generates a long tool call. The Desktop-embedded
// Claude Code CLI runs with the session environment Desktop gives Cowork conversations, including the
// local-agent entrypoint that makes the launch environment win over settings files, and an isolated
// config, so nothing in ~/.claude, the Claude-3p profile or Ollama is read or changed.

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const {
  PERSISTENT_OVERRIDES, PING_INTERVAL_MS, proxyOverrides, configureSession, startKeepAliveProxy,
} = require('./claude-3p-context.cjs');

const SCENARIOS = {
  control: { about: 'Desktop defaults', ccd: false, proxy: false },
  noproxy: { about: 'ccd settings without the keep-alive proxy', ccd: true, proxy: false },
  fix: { about: 'ccd settings and keep-alive proxy', ccd: true, proxy: true },
};
// What Desktop sets for every Cowork CLI that matters here (see the README).
const DESKTOP_ENV = {
  API_FORCE_IDLE_TIMEOUT: '1',
  API_TIMEOUT_MS: '900000',
  CLAUDE_CODE_ENTRYPOINT: 'local-agent',
  CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
  CLAUDE_CODE_HOST_AUTH_ENV_VAR: 'ANTHROPIC_AUTH_TOKEN',
};
const MARKER = 'SURVIVED_SILENCE';
const EXIT_GRACE_MS = 60000;

const USAGE = `Usage: node stream-timeout-harness.cjs [options]

  --cli PATH              Desktop-embedded Claude Code CLI (default: $CLAUDE_3P_TEST_CLI or newest
                          ~/Library/Application Support/Claude-3p/claude-code/*/*/claude.app/Contents/MacOS/claude)
  --silence-seconds N     Byte-silent gap after the first SSE events (default: 420)
  --ping-seconds N        Keep-alive proxy ping interval (default: ${PING_INTERVAL_MS / 1000}, as installed)
  --scenarios LIST        Comma-separated subset of: ${Object.keys(SCENARIOS).join(', ')} (default: all)
  --keep                  Keep the temporary directory with configs and CLI diagnostics`;

function parseArgs(argv) {
  const options = {
    cli: process.env.CLAUDE_3P_TEST_CLI,
    silenceSeconds: 420,
    pingSeconds: PING_INTERVAL_MS / 1000,
    scenarios: Object.keys(SCENARIOS),
    keep: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[++i];
    };
    if (arg === '--cli') options.cli = value();
    else if (arg === '--silence-seconds') options.silenceSeconds = Number(value());
    else if (arg === '--ping-seconds') options.pingSeconds = Number(value());
    else if (arg === '--scenarios') options.scenarios = value().split(',').map(name => name.trim()).filter(Boolean);
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}\n\n${USAGE}`);
  }
  for (const [name, seconds] of [['--silence-seconds', options.silenceSeconds], ['--ping-seconds', options.pingSeconds]]) {
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`${name} must be a positive number.`);
  }
  const unknown = options.scenarios.filter(name => !Object.hasOwn(SCENARIOS, name));
  if (unknown.length || options.scenarios.length === 0) {
    throw new Error(`Unknown or empty scenarios: ${unknown.join(', ') || '(none)'}\n\n${USAGE}`);
  }
  return options;
}

function directories(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function compareVersions(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] || 0) - (right[i] || 0);
    if (difference) return difference;
  }
  return 0;
}

function findEmbeddedCli() {
  const base = path.join(os.homedir(), 'Library/Application Support/Claude-3p/claude-code');
  const candidates = [];
  for (const version of directories(base)) {
    for (const build of directories(path.join(base, version))) {
      const file = path.join(base, version, build, 'claude.app/Contents/MacOS/claude');
      if (fs.existsSync(file)) candidates.push({ version, file });
    }
  }
  candidates.sort((a, b) => compareVersions(b.version, a.version));
  return candidates[0]?.file;
}

function startFakeGateway(silenceMs) {
  let resolveOutcome;
  const outcome = new Promise(resolve => { resolveOutcome = resolve; });
  let firstStreamSeen = false;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'not found' } }));
        return;
      }
      let request = {};
      try {
        request = JSON.parse(body);
      } catch {
        // The request body is irrelevant to the timing being measured.
      }
      // Only the first streaming response is measured; retries and the non-streaming fallback are held open.
      if (request.stream !== true || firstStreamSeen) return;
      firstStreamSeen = true;

      const started = Date.now();
      let finished = false;
      const message = {
        id: 'msg_offline_harness', type: 'message', role: 'assistant', model: request.model || 'offline',
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
      };
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      send('message_start', { type: 'message_start', message });
      send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'STREAM_' } });

      const timer = setTimeout(() => {
        if (res.destroyed) return;
        finished = true;
        send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: MARKER } });
        send('content_block_stop', { type: 'content_block_stop', index: 0 });
        send('message_delta', {
          type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 },
        });
        send('message_stop', { type: 'message_stop' });
        res.end();
        resolveOutcome({ completed: true, seconds: (Date.now() - started) / 1000 });
      }, silenceMs);
      res.on('close', () => {
        clearTimeout(timer);
        if (!finished) resolveOutcome({ completed: false, seconds: (Date.now() - started) / 1000 });
      });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, outcome }));
  });
}

function prepareConfig(dir, scenario, proxyPort) {
  if (scenario.ccd) {
    // Use the helper's own merge so the check covers exactly what ccd writes.
    const root = path.join(dir, 'sessions');
    const config = path.join(root, '11111111', '22222222', '33333333', '.claude');
    fs.mkdirSync(config, { recursive: true });
    configureSession(root, config, { ...PERSISTENT_OVERRIDES, ...(scenario.proxy ? proxyOverrides(proxyPort) : {}) });
    return config;
  }
  const config = path.join(dir, 'config');
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, 'settings.json'), '{}\n');
  return config;
}

function diagnosticsSummary(file) {
  if (!fs.existsSync(file)) return '';
  const notes = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.event === 'cli_byte_watchdog_fired') notes.push(`byte watchdog fired after ${entry.data?.idle_ms} ms`);
    if (entry.event === 'cli_stream_failed') notes.push(`stream failed: ${entry.data?.error_name ?? entry.data?.error_kind}`);
    if (entry.event === 'cli_nonstreaming_fallback_started') notes.push('non-streaming fallback started');
  }
  return [...new Set(notes)].join('; ');
}

async function runScenario(name, options, workRoot, children) {
  const scenario = SCENARIOS[name];
  const dir = path.join(workRoot, name);
  const home = path.join(dir, 'home');
  const tmp = path.join(dir, 'tmp');
  const cwd = path.join(dir, 'work');
  [home, tmp, cwd].forEach(folder => fs.mkdirSync(folder, { recursive: true }));
  const proxy = scenario.proxy
    ? await startKeepAliveProxy({ port: 0, pingIntervalMs: options.pingSeconds * 1000 })
    : undefined;
  const config = prepareConfig(dir, scenario, proxy?.port);
  const diagnostics = path.join(dir, 'cli-diagnostics.jsonl');
  const gateway = await startFakeGateway(options.silenceSeconds * 1000);

  const env = {
    HOME: home,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    TMPDIR: `${tmp}/`,
    CLAUDE_CONFIG_DIR: config,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${gateway.port}`,
    ANTHROPIC_AUTH_TOKEN: 'offline-harness',
    CLAUDE_CODE_DIAGNOSTICS_FILE: diagnostics,
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_GROWTHBOOK: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ...DESKTOP_ENV,
  };
  const child = cp.spawn(options.cli, [
    '-p', 'Reply with hi', '--model', 'claude-sonnet-4-6', '--max-turns', '1',
    '--setting-sources', 'user', '--no-session-persistence', '--tools', '',
  ], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise(resolve => {
    child.once('error', error => resolve({ error }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  let verdict;
  try {
    const first = await Promise.race([gateway.outcome, exited.then(exit => ({ exit }))]);
    if (first.exit) {
      const reason = first.exit.error?.message ?? `exit code ${first.exit.code ?? first.exit.signal}`;
      verdict = { survived: false, result: 'CLI EXITED EARLY', detail: `${reason}: ${output.trim().slice(-300)}` };
    } else if (first.completed) {
      let graceTimer;
      const exit = await Promise.race([
        exited,
        new Promise(resolve => { graceTimer = setTimeout(() => resolve(undefined), EXIT_GRACE_MS); }),
      ]);
      clearTimeout(graceTimer);
      const survived = output.includes(MARKER);
      verdict = {
        survived,
        result: survived ? `SURVIVED ${first.seconds.toFixed(0)}s silence` : 'STREAM ENDED WITHOUT OUTPUT',
        detail: survived ? '' : `CLI ${exit ? `exit ${exit.code}` : 'still running'}: ${output.trim().slice(-300)}`,
      };
    } else {
      verdict = { survived: false, result: `CUT after ${first.seconds.toFixed(1)}s`, detail: '' };
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await exited;
    }
    children.delete(child);
    gateway.server.closeAllConnections();
    gateway.server.close();
    await proxy?.close();
  }
  const notes = [proxy ? `proxy sent ${proxy.stats.pings} ping(s)` : '', diagnosticsSummary(diagnostics)];
  return { name, scenario, ...verdict, notes: notes.filter(Boolean).join('; ') };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  options.cli ??= findEmbeddedCli();
  if (!options.cli || !fs.existsSync(options.cli)) {
    throw new Error('Desktop-embedded Claude Code CLI not found. Start a Claude 3P conversation once, or pass --cli PATH.');
  }
  const workRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccd-stream-harness-')));
  const children = new Set();
  const cleanUp = () => {
    for (const child of children) child.kill('SIGTERM');
    if (!options.keep) fs.rmSync(workRoot, { recursive: true, force: true });
  };
  process.once('SIGINT', () => {
    cleanUp();
    process.exit(130);
  });

  console.log(`CLI: ${options.cli}`);
  console.log(`Desktop session env: ${Object.entries(DESKTOP_ENV).map(([key, value]) => `${key}=${value}`).join(' ')}`);
  console.log(`Byte-silent gap: ${options.silenceSeconds}s. Running ${options.scenarios.join(', ')} in parallel; ` +
    `expect about ${Math.ceil((options.silenceSeconds + 20) / 60)} minute(s).`);
  try {
    const results = await Promise.all(options.scenarios.map(name => runScenario(name, options, workRoot, children)));
    console.log('');
    for (const { name, scenario, result, detail, notes } of results) {
      const extra = [notes, detail].filter(Boolean).join('; ');
      console.log(`${name.padEnd(11)} ${result.padEnd(24)} ${scenario.about}${extra ? ` [${extra}]` : ''}`);
    }
    console.log('');
    const byName = Object.fromEntries(results.map(entry => [entry.name, entry]));
    if (byName.control?.survived && options.silenceSeconds > 300) {
      console.log('Note: Desktop defaults also survived; this Desktop build may no longer need the keep-alive proxy.');
    }
    if (byName.noproxy?.survived && options.silenceSeconds > 360) {
      console.log('Note: settings alone survived; Desktop may no longer force API_FORCE_IDLE_TIMEOUT=1.');
    }
    if (byName.fix && !byName.fix.survived) {
      console.log('FAIL: ccd settings and keep-alive proxy did not keep the silent stream alive with this CLI build.');
      process.exitCode = 1;
    } else if (byName.fix) {
      console.log('OK: ccd settings and keep-alive proxy keep a byte-silent stream alive with this CLI build.');
    }
    if (options.keep) console.log(`Kept: ${workRoot}`);
  } finally {
    cleanUp();
  }
}

main().catch(error => {
  console.error(`stream-timeout-harness: ${error.message}`);
  process.exitCode = 1;
});
