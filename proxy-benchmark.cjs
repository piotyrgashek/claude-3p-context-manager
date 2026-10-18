#!/usr/bin/env node
'use strict';

// Measures what the ccd keep-alive proxy adds to Claude traffic. The same requests go to a local fake
// Anthropic endpoint directly and through a keep-alive proxy started from the helper module in its own
// process, as the installed helper runs it. It also times the watcher's settings sweep, which shares the
// proxy's thread, on the conversations folder using only read operations. It never contacts the
// installed proxy, Claude, Ollama or a model, and changes no files.

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { locations, scan } = require('./claude-3p-context.cjs');

const HELPER = path.join(__dirname, 'claude-3p-context.cjs');
const MODES = {
  full: { warmup: 30, small: 300, upload: 30, burst: 10, burstEvents: 5000, paced: 150, sweeps: 50 },
  quick: { warmup: 3, small: 20, upload: 3, burst: 2, burstEvents: 500, paced: 20, sweeps: 5 },
};
// About 22 events per second, the token rate of the local model this helper was tuned with.
const PACED_GAP_MS = 45;
// Roughly the JSON request body of a conversation near the 131k-token window.
const UPLOAD_BYTES = 800 * 1024;

const USAGE = `Usage: node proxy-benchmark.cjs [--quick]

  --quick   Fewer iterations: a few seconds instead of about 15, with noisier numbers.

Safe while the helper runs: it starts its own proxy on a free port and a fake local endpoint.
For clean numbers, run it while no Cowork turn is active.`;

const now = () => Number(process.hrtime.bigint()) / 1e6;
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];
const median = values => percentile(values, 0.5);
const ms = value => `${value < 10 ? value.toFixed(2) : value.toFixed(1)} ms`;

function parseArgs(argv) {
  let mode = 'full';
  for (const arg of argv) {
    if (arg === '--quick') mode = 'quick';
    else if (arg === '--help' || arg === '-h') return { help: true };
    else throw new Error(`Unknown option: ${arg}\n\n${USAGE}`);
  }
  return { mode, plan: MODES[mode] };
}

function startUpstream() {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const query = new URL(req.url, 'http://local').searchParams;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (query.get('mode') === 'burst') {
        const total = Number(query.get('n'));
        const filler = 'x'.repeat(200);
        let i = 0;
        const pump = () => {
          while (i < total) {
            const more = res.write(`event: content_block_delta\ndata: {"i":${i},"t":"${filler}"}\n\n`);
            i++;
            if (!more) {
              res.once('drain', pump);
              return;
            }
          }
          res.end();
        };
        pump();
      } else if (query.get('mode') === 'paced') {
        const total = Number(query.get('n'));
        let i = 0;
        const timer = setInterval(() => {
          res.write(`event: content_block_delta\ndata: {"i":${i},"sent":${now()}}\n\n`);
          if (++i >= total) {
            clearInterval(timer);
            res.end();
          }
        }, PACED_GAP_MS);
      } else {
        res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      }
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function startProxy() {
  const code = [
    'const { startKeepAliveProxy } = require(process.argv[1]);',
    'startKeepAliveProxy({ port: 0 }).then(proxy => console.log(proxy.port));',
    'process.stdin.on("end", () => process.exit(0)).resume();',
    'setTimeout(() => process.exit(0), 600000).unref();',
  ].join('\n');
  const child = cp.spawn(process.execPath, ['-e', code, HELPER], { stdio: ['pipe', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', status => reject(new Error(`The benchmark proxy exited early (${status}).`)));
    child.stdout.once('data', data => resolve({ child, port: Number(String(data).trim()) }));
  });
}

function post(options, body) {
  return new Promise((resolve, reject) => {
    const started = now();
    const req = http.request({
      ...options,
      method: 'POST',
      headers: { ...options.headers, 'content-type': 'application/json', 'content-length': body.length },
    }, res => {
      let bytes = 0;
      let buffer = '';
      const delays = [];
      res.setEncoding('utf8');
      res.on('data', chunk => {
        const at = now();
        bytes += Buffer.byteLength(chunk);
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const sent = /"sent":([\d.]+)/.exec(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
          if (sent) delays.push(at - Number(sent[1]));
        }
      });
      res.on('end', () => resolve({ total: now() - started, bytes, delays }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function timeSweeps(count) {
  const root = locations().root;
  if (!fs.existsSync(root)) return undefined;
  // The file operations of a watcher sweep when no conversation needs changes.
  const readOnly = (base, dir) => {
    let current = base;
    fs.lstatSync(current);
    for (const part of path.relative(base, dir).split(path.sep)) fs.lstatSync(current = path.join(current, part));
    for (const name of ['settings.json', '.ccd-context-backup.json']) {
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) continue;
      fs.lstatSync(file);
      try {
        JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        // The watcher reports malformed files; the time spent reading them is what counts here.
      }
    }
    return false;
  };
  const times = [];
  let sessions = 0;
  for (let i = 0; i < count; i++) {
    const started = now();
    sessions = scan(root, readOnly).sessions;
    times.push(now() - started);
  }
  return { sessions, times };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const { plan } = options;
  const upstream = await startUpstream();
  const upstreamPort = upstream.address().port;
  const proxy = await startProxy();
  process.once('SIGINT', () => {
    proxy.child.kill();
    process.exit(130);
  });
  const agents = { direct: new http.Agent({ keepAlive: true }), proxy: new http.Agent({ keepAlive: true }) };
  const route = (kind, query) => ({
    agent: agents[kind],
    host: '127.0.0.1',
    port: kind === 'direct' ? upstreamPort : proxy.port,
    path: kind === 'direct' ? `/v1/messages?${query}` : `http://127.0.0.1:${upstreamPort}/v1/messages?${query}`,
    headers: { host: `127.0.0.1:${upstreamPort}` },
  });
  // Alternating the two routes spreads any background load evenly over both.
  const compare = async (query, body, runs) => {
    const results = { direct: [], proxy: [] };
    for (let i = 0; i < runs; i++) {
      for (const kind of ['direct', 'proxy']) results[kind].push(await post(route(kind, query), body));
    }
    return results;
  };

  try {
    console.log(`Node ${process.version} on ${os.platform()} ${os.arch()}; ${options.mode} run.\n`);
    const small = Buffer.alloc(2 * 1024, 'a');
    await compare('mode=small', small, plan.warmup);
    const latency = await compare('mode=small', small, plan.small);
    const upload = await compare('mode=small', Buffer.alloc(UPLOAD_BYTES, 'a'), plan.upload);
    const burst = await compare(`mode=burst&n=${plan.burstEvents}`, small, plan.burst);
    const paced = await compare(`mode=paced&n=${plan.paced}`, small, 1);
    const sweep = timeSweeps(plan.sweeps);

    const rows = [['Measurement', 'Direct', 'Through proxy', 'Difference']];
    const added = (label, direct, proxied) => {
      const difference = proxied - direct;
      rows.push([label, ms(direct), ms(proxied), `${difference < 0 ? '-' : '+'}${ms(Math.abs(difference))}`]);
    };
    const totals = (results, kind) => results[kind].map(result => result.total);
    added('Small request round trip, median', median(totals(latency, 'direct')), median(totals(latency, 'proxy')));
    added('Small request round trip, p95',
      percentile(totals(latency, 'direct'), 0.95), percentile(totals(latency, 'proxy'), 0.95));
    added(`Request with an ${UPLOAD_BYTES / 1024} KB body, median`,
      median(totals(upload, 'direct')), median(totals(upload, 'proxy')));
    const rate = kind => median(burst[kind].map(result => result.bytes / 1e6 / (result.total / 1000)));
    const change = (rate('proxy') / rate('direct') - 1) * 100;
    rows.push([`${(burst.direct[0].bytes / 1e6).toFixed(2)} MB event burst, median throughput`,
      `${rate('direct').toFixed(0)} MB/s`, `${rate('proxy').toFixed(0)} MB/s`,
      `${change < 0 ? '' : '+'}${change.toFixed(0)}%`]);
    const delays = kind => paced[kind][0].delays;
    added('Delay per event at 22 events/s, median', median(delays('direct')), median(delays('proxy')));
    added('Delay per event at 22 events/s, p99', percentile(delays('direct'), 0.99), percentile(delays('proxy'), 0.99));

    const widths = [40, 12, 14];
    for (const row of rows) console.log(row.map((cell, i) => (i < widths.length ? cell.padEnd(widths[i]) : cell)).join(' '));
    console.log(sweep
      ? `\nWatcher sweep of ${sweep.sessions} conversation(s), which pauses the proxy while it runs: ` +
        `median ${ms(median(sweep.times))}, max ${ms(Math.max(...sweep.times))}.`
      : '\nWatcher sweep: skipped, there is no conversations folder yet.');
  } finally {
    agents.direct.destroy();
    agents.proxy.destroy();
    upstream.close();
    proxy.child.stdin.end();
  }
}

main().catch(error => {
  console.error(`proxy-benchmark: ${error.message}`);
  process.exitCode = 1;
});
