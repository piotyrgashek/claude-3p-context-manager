# Claude Desktop 3P context-window and stream-timeout manager

A macOS launcher and watcher that gives local Claude 3P Cowork conversations a
**131,072-token auto-compaction window** and **keeps slow local-model streams
alive long enough to write large files**, without changing terminal Claude Code
configuration or Ollama.

## What it does

The `ccd` command updates existing 3P conversation settings, starts a background
helper for newly created conversations, then opens `/Applications/Claude.app`
with `--3p`. The helper also runs a small **keep-alive proxy** on
`127.0.0.1:11535` for as long as it runs.

It merges only these environment settings:

```json
{
  "env": {
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "131072",
    "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "85",
    "CLAUDE_STREAM_IDLE_TIMEOUT_MS": "1800000",
    "HTTP_PROXY": "http://127.0.0.1:11535"
  }
}
```

The first three stay after the helper stops. `HTTP_PROXY` is present only while
the helper and its proxy run: the helper adds it when it starts and removes it
again when it stops, so a Claude launched later without `ccd` is never pointed at
a proxy that is not running.

The settings go inside each conversation's isolated `.claude/settings.json`,
under:

```text
~/Library/Application Support/Claude-3p/local-agent-mode-sessions/
```

They do not go in `~/.claude/settings.json`. Desktop starts each conversation's
embedded Claude Code CLI with `CLAUDE_CONFIG_DIR` pointing at that conversation's
`.claude` folder (through a symlink under `$TMPDIR/claude-hostloop-plugins/`), so
terminal Claude Code settings never reach Desktop conversations and these
settings never reach the terminal. In the observed Desktop build, setting the
same variables on the process launched by `open --env` did not pass them through
to the Cowork runtime.

**The compaction window is a budget, not a hard request-size limit.** It does not
change the model's actual capacity, weights, alias, or Ollama `num_ctx`. A large
single tool result or generation can still exceed available capacity.
The runtime also reserves a compaction buffer, so the `85` setting does not
promise compaction at exactly 85% of 131,072.

### Why the keep-alive proxy is needed

Symptoms: a local model (observed with GLM-4.7-Flash Q8 on Ollama) fails while
writing a large file or a large edit. Either it "runs in circles" (the chat
repeatedly gets the hidden nudge *"Your response above was cut off mid-stream.
Resume directly from where it stops"* and no file appears), or the turn ends with
**"API Error: The operation timed out."** and a *"The response stopped arriving"*
card. Writing the same content as plain chat text works.

Cause: Ollama does not stream a tool call. Its parser buffers the whole call
(for example a `Write` holding the complete `.md` file) and sends it only when
it is finished, and the Ollama Claude gateway sends no keep-alive pings, so the
connection is byte-silent while the model generates it. Desktop starts every
Cowork CLI with `API_FORCE_IDLE_TIMEOUT=1` and `API_TIMEOUT_MS=900000`, which
leave two limits on a silent connection:

| Limit | Default | What you see | Evidence in `~/Library/Logs/Claude-3p/cli-diagnostics.jsonl` |
| --- | --- | --- | --- |
| CLI stream watchdog | 300 s | "cut off mid-stream" loop | `cli_byte_watchdog_fired` with `"idle_ms":300000`, then `cli_stream_failed` (`StreamIdleTimeoutError`) |
| HTTP idle timeout forced by `API_FORCE_IDLE_TIMEOUT=1` | about 5–6 min | "API Error: The operation timed out." | `cli_stream_failed` (`TimeoutError`, `"watchdog_fired":false`) after about 330–370 s |

After either failure the CLI retries without streaming; that retry is cut by the
same idle timeout unless it finishes within about 5–6 minutes. At about 20–24
tokens/s, a single tool call longer than roughly 6,000–7,000 tokens is likely to
fail, and each retry starts the generation from scratch.

Why settings alone cannot fix it: Desktop starts Cowork CLIs with
`CLAUDE_CODE_ENTRYPOINT=local-agent`. In that mode the CLI lets the launch
environment win over every settings file, so a conversation's `settings.json`
cannot change a variable Desktop already sets. The CLI logs this with `--debug`:

```text
Ignoring API_FORCE_IDLE_TIMEOUT, API_TIMEOUT_MS from userSettings: the environment this session was
launched with already sets them, and when the desktop app or a runner starts the session, the launch
environment takes precedence over settings.
```

Version 2 of this helper wrote `API_FORCE_IDLE_TIMEOUT=0` and `API_TIMEOUT_MS`
anyway; they had no effect, so version 3 removes them and restores their original
values. Desktop's 3P configuration has no key for them, Desktop's own **Stream
idle timeout** key (`inferenceStreamIdleTimeoutSec`) only sets
`CLAUDE_STREAM_IDLE_TIMEOUT_MS`, and `BUN_CONFIG_HTTP_IDLE_TIMEOUT` is read only
from the launch environment.

Fix: Desktop's own documentation for the stream idle timeout says long silent
generations need a gateway that sends SSE keep-alive `ping` events. The Ollama
gateway does not, and Ollama.app rewrites Desktop's 3P gateway configuration
every time it starts, so the helper puts its proxy in front of the gateway through
the conversation's `HTTP_PROXY` instead (the CLI honors it from `settings.json`
because Desktop does not set it):

| Part | Effect |
| --- | --- |
| Keep-alive proxy, `HTTP_PROXY=http://127.0.0.1:11535` | Relays all of the CLI's traffic unchanged and inserts `event: ping` into a Server-Sent Events response, between events only, after every 15 s of upstream silence. Bytes keep flowing, so neither limit above fires. |
| `CLAUDE_STREAM_IDLE_TIMEOUT_MS=1800000` | With pings arriving, the CLI accepts about five minutes of keep-alives plus this much more for real model output (per Desktop's own description of the setting): about 35 minutes of model silence instead of about 10. A 16-minute silent stream was verified to survive. |

If the client gives up, the proxy cancels the upstream request so the model stops
generating. Trade-off: a stalled model that keeps the connection open is
abandoned after about 35 minutes instead of 5–10.

The proxy cannot help before the response starts (while Ollama processes the
prompt, which is the first-byte wait) or in the CLI's non-streaming fallback,
which returns one JSON body. Neither is a silent stream once the proxy is in
place, because the fallback is only used after a stream fails.

## Package contents

| File | Purpose |
| --- | --- |
| `claude-3p-context.cjs` | Working launcher, settings updater, watcher, keep-alive proxy, status and restore commands |
| `ccd.zsh` | Portable `ccd` shell function to source from `.zshrc` |
| `install.zsh` | Installs the helper and shell binding into `~/.local/bin` |
| `claude-3p-context.test.cjs` | Optional isolated checks using Node's built-in test runner |
| `stream-timeout-harness.cjs` | Optional offline reproduction of the silent-stream failures with Desktop's session environment, and check of the fix |
| `README.md` | This installation, usage and recovery guide |

Copy this whole folder to the other Mac. Do not copy your existing Claude
profile, credentials, conversation folders or watcher PID file.

## Prerequisites on a fresh Mac

1. Install Claude Desktop at `/Applications/Claude.app`.
2. Install Node.js 22 or newer and make `node` available in your terminal.
   An official Node.js installer, Homebrew, or a version manager is sufficient;
   there are no npm dependencies. Check with `node --version`.
3. Configure Claude's third-party inference connection and confirm a simple
   Cowork conversation works before installing this helper. The helper does
   not install or configure a provider, authentication, connectors or models.
4. If using Ollama Switch, keep the Mac Ollama app and its Claude integration
   running. Use a supported Claude alias mapped to the desired backend model.
   The helper does not require changing that mapping to the native GLM ID.
5. Finish active Claude work and fully quit Claude with Command-Q.

Use your normal user account, not `sudo`. This package is for local, host-based
Cowork on macOS, not remote/cloud Cowork or a full-VM-only deployment.

## Install

In Terminal, change to the copied package directory. Replace the example path
with its actual location:

```zsh
cd "/path/to/repo"
zsh ./install.zsh
```

The installer creates:

```text
~/.local/bin/claude-3p-context.cjs
~/.local/bin/ccd.zsh
```

It does not start Claude or a watcher, edit `.zshrc`, or modify Claude/Ollama
configuration. It refuses symlinked installation targets. If a different
version of either installed script exists, it saves a sibling
`<filename>.backup.<random-suffix>` before replacing it. Identical files are
left unchanged.

For an existing installation, run `ccd stop` before reinstalling. The installer
refuses to overwrite a running installed helper.

### Upgrading from version 1 or 2

Version 1 managed only the compaction window; version 2 added timeout settings
that turned out to be ignored in Desktop sessions. Finish the active turn and
quit Claude with Command-Q, then:

```zsh
ccd stop
cd "/path/to/repo"
zsh ./install.zsh
ccd
```

On start, the helper adds `CLAUDE_STREAM_IDLE_TIMEOUT_MS` and the proxy setting
to every existing conversation, removes version 2's `API_FORCE_IDLE_TIMEOUT` and
`API_TIMEOUT_MS` (restoring any value they replaced), and updates each
conversation's `.ccd-context-backup.json` to match, so `ccd restore` still undoes
everything. A conversation whose CLI is already running keeps its old settings
until that CLI restarts, which is why quitting Claude first is recommended. If
you skip it, wait about five idle minutes until Desktop retires the conversation's
warm process.

## Bind `ccd` in `.zshrc`

Open `~/.zshrc` in your editor. Replace any previous `ccd()` function or `ccd`
alias with this line:

```zsh
source "$HOME/.local/bin/ccd.zsh"
```

Leave other aliases, including direct terminal Claude Code launch aliases,
untouched. Put this after any Node version-manager initialization. If your
shell uses `ZDOTDIR`, edit the `.zshrc` in that directory instead.

Reload your shell configuration:

```zsh
source ~/.zshrc
```

With a custom `ZDOTDIR`, reload that configuration instead:

```zsh
source "$ZDOTDIR/.zshrc"
```

Sourcing the binding only defines a function; it does not launch anything.
Unlike the original machine-specific function, it does not hardcode
`/opt/homebrew/bin/node`.

## Launch and observe the result

With your provider/relay available:

```zsh
ccd
ccd status
```

The launcher and status lines report the managed budgets and the proxy:

```text
Claude 3P helper running (PID 12345). Auto-compact window: 131072. Stream idle timeout: 1800s.
Keep-alive proxy: http://127.0.0.1:11535 (pings silent streams every 15s).
Running: PID 12345; window=131072; stream idle timeout=1800s; keep-alive proxy=http://127.0.0.1:11535
```

Start a new Cowork conversation and run:

```text
/context
```

An observed result from the original installation was:

```text
Model: claude-sonnet-4-6
Tokens: 46.1k / 131.1k (35%)
```

The model name can remain a Claude alias; the important part is the
approximately **131.1k** budget. Your used-token count will differ. The embedded
CLI versions exercised for this package showed a **33k autocompact buffer**.

New conversation directories only appear when a conversation starts. The
watcher responds to filesystem events and also scans every two seconds, but
it cannot guarantee an update before a new session's first request. If the
budget is still 200k or 500k, wait a few seconds, finish or stop the active turn,
fully quit Claude, then run `ccd` again and reopen that same conversation.
Its settings file should now exist before the runtime starts.

**Use `ccd` to launch subsequent 3P sessions.** Launching only from Finder or
Switch will not start this helper if it is no longer running; conversations then
work without the keep-alive proxy, and long tool calls can fail again.

To confirm the settings reached a conversation, inspect its settings file. The
conversation ID is the eight-character folder named in the helper log line
`Configured <id>/<id>/<id>/.claude`:

```zsh
cat "$HOME/Library/Application Support/Claude-3p/local-agent-mode-sessions/<id>/<id>/<id>/.claude/settings.json"
```

While the helper runs it contains `HTTP_PROXY`. After a long generation, the helper
log shows a line such as
`Keep-alive proxy: sent 21 ping(s) during 330s of upstream silence.`, and no new
`cli_byte_watchdog_fired` or `TimeoutError` lines appear in
`~/Library/Logs/Claude-3p/cli-diagnostics.jsonl`.

## Commands

| Command | Behavior |
| --- | --- |
| `ccd` or `ccd start` | Start/reuse the helper and its keep-alive proxy, then open Claude in 3P mode |
| `ccd status` | Show helper status, proxy address, scope and log path; warns if conversations still point at a stopped proxy |
| `ccd stop` | Stop the helper and proxy and remove `HTTP_PROXY` from conversations; the other settings remain |
| `ccd restore` | Stop the helper and undo all of its recorded settings changes |

The helper exits about a minute after Claude's `--3p` process disappears, and
removes `HTTP_PROXY` from conversations as it exits. It is not a login item or
system daemon. After rebooting or a longer period with Claude closed, start it
again with `ccd`. Stopping the helper while Claude is open interrupts
conversations whose CLI is already running until the helper is started again on
the same port, so finish active turns first.

If the function is unavailable, invoke the installed helper directly:

```zsh
node "$HOME/.local/bin/claude-3p-context.cjs" status
```

The same form accepts `start`, `stop` and `restore`.

## Isolation and backups

The helper only matches this layout, with three eight-character hexadecimal
directory IDs:

```text
Claude-3p/local-agent-mode-sessions/<id>/<id>/<id>/.claude/settings.json
```

All matching local conversation directories are covered, including future ones
while the helper runs. The setting is profile-directory-scoped, not conditional
on which model alias is selected.

The helper does not edit:

- `~/.claude/` or your terminal Claude Code executable/settings.
- `/Library/Application Support/ClaudeCode/` or machine-managed settings.
- The standard `Claude` profile or the separate `claude-code-sessions` directory.
- Ollama configuration, models, server settings or relay mappings.
- Conversation transcripts, documents or MCP connector configuration.

Before changing a conversation's settings, it creates
`.ccd-context-backup.json` alongside them. This records only the original
values/presence of the managed variables, not a copy of the whole settings
file. Backups written by versions 1 and 2 are accepted and updated in place:
newly managed variables get their original values recorded before they are
applied, and version 2's retired variables are restored and dropped. Restore
undoes exactly the variables a backup records, preserves unrelated settings and
keeps later edits to those variables that no longer match the helper's applied
values. While watching is active, the managed variables are continually
reapplied; stop it before deliberately changing them yourself.

Malformed JSON, invalid `env` objects and symlinked session/configuration
targets are refused rather than overwritten. Existing unrelated JSON keys
are retained; updated files are formatted as ordinary JSON.

### The keep-alive proxy

The proxy runs inside the helper process and listens only on `127.0.0.1:11535`.
Only the Claude conversations that the helper configures use it; nothing else on
the Mac is pointed at it, and the terminal CLI never sees `HTTP_PROXY`.

- It accepts only proxy requests: an absolute `http://` request target, or
  `CONNECT` for HTTPS, which it tunnels without inspecting. Anything else
  receives `400`.
- It forwards headers and bodies unchanged, including authorization, and does
  not log them. It logs a line only when it had to send pings, plus connection
  errors.
- It inserts pings only into `200` `text/event-stream` responses without content
  encoding, only between complete events, and only after 15 s of upstream
  silence.
- Uppercase `HTTP_PROXY` is used because the CLI honors it for all of its
  requests, while common child tools such as `curl` ignore it.
- `CCD_PROXY_PORT` in the environment of `ccd` overrides the port, and `0`
  picks a free one. The tests use that; normal use needs no change.

## Logs and troubleshooting

```zsh
ccd status
tail -40 "$HOME/Library/Application Support/Claude-3p/context-window-helper/watcher.log"
```

Runtime state lives here:

```text
~/Library/Application Support/Claude-3p/context-window-helper/
    watcher.json
    watcher.log
```

| Symptom | Action |
| --- | --- |
| `node` is missing | Install Node.js 22+, ensure it is on `PATH`, then reload the shell. |
| Installer says the helper is running | Run `ccd stop`, then reinstall. |
| Standard Claude is already open | Finish its work and fully quit it before launching `ccd`. |
| `/context` still reports 200k/500k | Check the log, wait for the session update, then relaunch the same conversation as described above. |
| Desktop startup log still shows override variables as `undefined` | That log records the launch environment, not settings later loaded by the embedded CLI. Observe `/context` instead. |
| Invalid JSON or refused symlink | Inspect the exact path in the helper log. Do not replace the entire settings file or redirect it to your terminal CLI configuration. |
| Provider is unreachable | Start/repair the existing relay or provider connection separately; this helper does not manage it. |
| Model loops on large file writes ("cut off mid-stream"), or "API Error: The operation timed out." | Run `ccd status` and check that the conversation's `settings.json` contains `HTTP_PROXY`. Then restart its CLI with Command-Q and `ccd`. `cli_byte_watchdog_fired` or `TimeoutError` in `~/Library/Logs/Claude-3p/cli-diagnostics.jsonl` means that CLI is not using the proxy. |
| Every request fails quickly; a connection to `127.0.0.1:11535` is refused | The conversations still point at a proxy that is not running, for example after the helper was killed. Run `ccd` to restart it, or `ccd stop` to remove the setting. `ccd status` warns about this. |
| Helper log: `the keep-alive proxy could not start: listen EADDRINUSE` | Another program uses port 11535. Free it, or start with `CCD_PROXY_PORT=<free port> ccd`. The helper removes its proxy setting from conversations when it cannot start. |
| CLI debug log: `Ignoring API_FORCE_IDLE_TIMEOUT, API_TIMEOUT_MS from userSettings` | Left by version 2 in a conversation the helper has not updated yet; harmless. The warning disappears once version 3 has run. |
| `Unrecognized backup; left untouched` in the helper log | The backup was written by an unknown helper version or edited by hand. Inspect it; the helper refuses to guess. |
| Unsure whether a Desktop update still needs or accepts the fix | Run `node ./stream-timeout-harness.cjs` (about 8 minutes) and compare with the expected results below. |
| Context changes after a Desktop update | Recheck `/context` and the session-directory layout. This is a version-dependent workaround, not an official Desktop setting. |

## Restore or uninstall

Finish the active turn and quit Claude. If the helper has been used, run:

```zsh
ccd restore
```

Restore stops the helper and its proxy and consumes the per-conversation backup
records. It does not delete a
conversation or an unrelated preference. If you only installed the scripts
and never launched `ccd`, there is no conversation configuration to restore.

To uninstall, remove the `source "$HOME/.local/bin/ccd.zsh"` line from your
shell configuration, then remove only the two installed files:

```zsh
rm "$HOME/.local/bin/claude-3p-context.cjs" "$HOME/.local/bin/ccd.zsh"
unfunction ccd
```

Do not delete the `Claude-3p` profile or `local-agent-mode-sessions` directory.
Keep this package for later reinstallations. Old installer backups and the
helper log can be retained for recovery; they are not automatically removed.

## Optional isolated checks

From this package directory:

```zsh
node --test ./claude-3p-context.test.cjs
```

These checks use temporary home/session directories and do not start the
actual Desktop app or modify the installed helper. They exercise merge,
restore, version 1 and 2 backup migration, proxy-setting release, the keep-alive
proxy (ping placement, unchanged relaying, `CONNECT` tunnels, upstream
cancellation, refusal of non-proxy requests), malformed JSON and backups, symlink
handling, watcher behavior and installation. Spawned watchers use a random proxy
port, temporary processes are stopped and fixtures are removed afterward.

The embedded-CLI context check is optional because its path changes with
Desktop updates. To include it, first locate your current executable:

```zsh
find "$HOME/Library/Application Support/Claude-3p/claude-code" \
    -maxdepth 6 -type f -path '*/Contents/MacOS/claude' -print
```

Use the current path from that output, not a path from another machine:

```zsh
CLAUDE_3P_TEST_CLI="/absolute/path/from/the/find/output" \
    node --test ./claude-3p-context.test.cjs
```

The optional checks invoke `/context` with an isolated configuration, no tools
and a non-serving loopback inference address, and run a 3-second version of
the stream-timeout harness (through the keep-alive proxy) against a local fake
server. They do not send a model prompt to your provider. A future runtime that
changes these settings or its output format may require an update to the checks
and to this workaround.

### Stream-timeout harness

`stream-timeout-harness.cjs` reproduces both silent-stream failures offline and
verifies the fix with the real embedded CLI. It starts a fake Anthropic endpoint
on `127.0.0.1` that sends the first SSE events and then stays byte-silent, like
Ollama while it generates a long tool call. It runs the embedded CLI with a
temporary config directory and the parts of Desktop's Cowork session environment
that decide the outcome:

```text
API_FORCE_IDLE_TIMEOUT=1  API_TIMEOUT_MS=900000  CLAUDE_CODE_ENTRYPOINT=local-agent
CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1  CLAUDE_CODE_HOST_AUTH_ENV_VAR=ANTHROPIC_AUTH_TOKEN
```

`CLAUDE_CODE_ENTRYPOINT=local-agent` matters most: without it the CLI lets settings
override the launch environment, which real Desktop sessions do not. Version 2 of
this harness lacked it and wrongly passed settings that Desktop ignores. The `noproxy`
and `fix` scenarios use the helper's own `configureSession`, and `fix` routes the
CLI through the helper's own `startKeepAliveProxy` with the installed 15 s ping
interval, so the check covers exactly what `ccd` runs. The harness does not read or
change `~/.claude`, the `Claude-3p` profile, Ollama, or your provider, and it
removes its temporary files afterward.

```zsh
node ./stream-timeout-harness.cjs
```

The CLI is found automatically (newest under
`~/Library/Application Support/Claude-3p/claude-code`), or pass
`--cli /absolute/path`. The three scenarios run in parallel and take about
8 minutes. Expected results with Desktop 2.42304.0 and embedded CLI 2.1.299:

```text
control     CUT after 300.0s         Desktop defaults [byte watchdog fired after 300000 ms; stream failed: StreamIdleTimeoutError; non-streaming fallback started]
noproxy     CUT after 360.xs         ccd settings without the keep-alive proxy [stream failed: TimeoutError; non-streaming fallback started]
fix         SURVIVED 420s silence    ccd settings and keep-alive proxy [proxy sent 27 ping(s)]

OK: ccd settings and keep-alive proxy keep a byte-silent stream alive with this CLI build.
```

`control` is the "cut off mid-stream" loop and `noproxy` is "API Error: The
operation timed out."; both match what the real conversations logged. The exit
status is non-zero only if `fix` is cut. The harness adds a note if `control`
survives more than 300 s or `noproxy` more than 360 s, which would mean a Desktop
build no longer needs the proxy. Other options:

| Option | Purpose |
| --- | --- |
| `--silence-seconds N` | Length of the silent gap (default 420; above 360 s exercises both limits) |
| `--scenarios fix,control` | Run a subset |
| `--ping-seconds N` | Proxy ping interval for `fix` (default 15, as installed) |
| `--keep` | Keep the temporary configs and CLI diagnostics for inspection |

A longer run checks the upper bound of the fix:
`node ./stream-timeout-harness.cjs --silence-seconds 960 --scenarios fix`
(about 17 minutes) silences the stream past Desktop's 15-minute `API_TIMEOUT_MS`
and past the roughly 10 minutes that Desktop's description of the stream idle
timeout allows with pings at its default. Expected:

```text
fix         SURVIVED 960s silence    ccd settings and keep-alive proxy [proxy sent 63 ping(s)]
```

## Compatibility notes

The working setup was first observed with Claude Desktop **2.26454.0** and its
embedded CLI **2.1.289** on macOS. The portable package was also exercised with
embedded CLI **2.1.293**, Node.js **26.5.0** and zsh **5.9**.

The stream-timeout settings (version 2) were diagnosed with Claude Desktop
**2.42304.0**, embedded CLI **2.1.299**, the Ollama macOS app **0.40.6** as Claude
gateway in front of an Ollama **0.40.5** server running `glm-4.7-flash` Q8 with a
131,072-token context, Node.js **26.5.0**, macOS **26.6.2** and zsh **5.9**. The
keep-alive proxy (version 3) was verified with the same versions.

There is no Windows/Linux support in this launcher. Different session storage,
a nonstandard app installation path, a symlinked home/install layout, remote
Cowork or full-VM execution may require adaptation. Recheck the actual Cowork
`/context` result after installing on another Mac or updating Desktop, and rerun
the stream-timeout harness.

This helper does not make Ollama stream tool calls, change thinking mode,
guarantee an exact compaction trigger, or enforce a hard limit on a single
request. It only keeps a silent stream alive, for up to about 35 minutes of model
silence, while the helper runs.
