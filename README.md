# Claude Desktop 3P context-window and stream-timeout manager

A macOS launcher and watcher that gives local Claude 3P Cowork conversations a
**131,072-token auto-compaction window** and **stream timeouts long enough for a
slow local model to write large files**, without changing terminal Claude Code
configuration or Ollama. This tool can be used to finetune your Claude Desktop 3p instance to utilize proper context window sizes, etc. Untill ollama provides those settings alongside with spoofing onto anthropic models.  

## What it does

The `ccd` command updates existing 3P conversation settings, starts a background
watcher for newly created conversations, then opens `/Applications/Claude.app`
with `--3p`.

It merges only these five environment settings:

```json
{
  "env": {
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "131072",
    "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "85",
    "API_FORCE_IDLE_TIMEOUT": "0",
    "CLAUDE_STREAM_IDLE_TIMEOUT_MS": "1800000",
    "API_TIMEOUT_MS": "2400000"
  }
}
```

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

### Why the stream-timeout settings are needed

Symptom: a local model (observed with GLM-4.7-Flash Q8 on Ollama) "runs in
circles" when asked to write a large file. It plans, then the chat repeatedly
shows the hidden nudge *"Your response above was cut off mid-stream. Resume
directly from where it stops"*, and no file appears. Writing the same content as
plain chat text works.

Cause: Ollama does not stream a tool call. Its parser buffers the whole call
(for example a `Write` holding the complete `.md` file) and sends it only when
it is finished, and the Ollama Claude gateway sends no keep-alive pings, so the
connection is byte-silent while the model generates it. Desktop starts every
Cowork CLI with `API_FORCE_IDLE_TIMEOUT=1` and `API_TIMEOUT_MS=900000`. With those
values the embedded CLI abandons a stream after **300 s** without bytes, retries
without streaming, and that attempt is cut after about **360 s**. At about 24
tokens/s, a single tool call longer than roughly 7,000 tokens is likely to be cut,
and each retry starts the generation from scratch.
The proof is in `~/Library/Logs/Claude-3p/cli-diagnostics.jsonl` as
`cli_byte_watchdog_fired` with `"idle_ms":300000`, followed by
`cli_stream_failed` (`StreamIdleTimeoutError`) and
`cli_nonstreaming_fallback_started`.

Fix: the three timeout settings match the values a tuned terminal Claude Code
already uses in `~/.claude/settings.json`, but they are written only to Desktop
conversations:

| Setting | Effect |
| --- | --- |
| `API_FORCE_IDLE_TIMEOUT=0` | Overrides Desktop's forced idle timeout, which cuts a silent connection after about 5–6 minutes |
| `CLAUDE_STREAM_IDLE_TIMEOUT_MS=1800000` | Raises the CLI's stream and byte watchdogs from 300 s to 30 minutes |
| `API_TIMEOUT_MS=2400000` | Raises the request and non-streaming fallback timeout from 15 to 40 minutes |

A conversation's `settings.json` values take precedence over the environment
Desktop gives the CLI; `stream-timeout-harness.cjs` verifies this offline.
Desktop's own **Stream idle timeout** setting (`inferenceStreamIdleTimeoutSec`)
only sets `CLAUDE_STREAM_IDLE_TIMEOUT_MS` and is not enough on its own: the
harness shows a silent stream still being cut at about 360 s.

Trade-off: a genuinely dead connection is now detected after up to 30 minutes
instead of 5, the same behavior as the tuned terminal CLI.

## Package contents

| File | Purpose |
| --- | --- |
| `claude-3p-context.cjs` | Working launcher, settings updater, watcher, status and restore commands |
| `ccd.zsh` | Portable `ccd` shell function to source from `.zshrc` |
| `install.zsh` | Installs the helper and shell binding into `~/.local/bin` |
| `claude-3p-context.test.cjs` | Optional isolated checks using Node's built-in test runner |
| `stream-timeout-harness.cjs` | Optional offline reproduction of the silent-stream cut-off and check of the fix |
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

### Upgrading from version 1 (compaction window only)

```zsh
ccd stop
cd "/path/to/repo"
zsh ./install.zsh
ccd
```

On start, the helper adds the three timeout settings to every existing
conversation. It also extends each conversation's version 1
`.ccd-context-backup.json` with the original values of the newly managed
settings, so `ccd restore` still undoes everything. A conversation whose CLI is
already running keeps its old settings until that CLI restarts. Fully quit Claude
with Command-Q and launch with `ccd` again, or wait about five idle minutes until
Desktop retires the conversation's warm process.

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

The launcher and status lines report both managed budgets:

```text
Claude 3P helper running (PID 12345). Auto-compact window: 131072. Stream idle timeout: 1800s.
Running: PID 12345; window=131072; stream idle timeout=1800s
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
Switch will not start this helper if it is no longer running.

To confirm the timeout settings reached a conversation, inspect its settings
file. The conversation ID is the eight-character folder named in the helper log
line `Configured <id>/<id>/<id>/.claude`:

```zsh
cat "$HOME/Library/Application Support/Claude-3p/local-agent-mode-sessions/<id>/<id>/<id>/.claude/settings.json"
```

After a long generation, no new `cli_byte_watchdog_fired` lines should appear in
`~/Library/Logs/Claude-3p/cli-diagnostics.jsonl`.

## Commands

| Command | Behavior |
| --- | --- |
| `ccd` or `ccd start` | Start/reuse the helper and open Claude in 3P mode |
| `ccd status` | Show helper status, its scope and its log path |
| `ccd stop` | Stop the helper; already applied conversation settings remain |
| `ccd restore` | Stop the helper and undo its recorded settings changes |

The watcher exits about a minute after Claude's `--3p` process disappears.
It is not a login item or system daemon. After rebooting or a longer period
with Claude closed, start it again with `ccd`.

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
file. Backups written by version 1 record only the two compaction variables;
version 2 accepts them and adds the original values of the timeout variables
before applying those. Restore undoes exactly the variables a backup records,
preserves unrelated settings and keeps later edits to those variables that no
longer match the helper's applied values. While watching is active, the managed
variables are continually reapplied; stop it before deliberately changing them
yourself.

Malformed JSON, invalid `env` objects and symlinked session/configuration
targets are refused rather than overwritten. Existing unrelated JSON keys
are retained; updated files are formatted as ordinary JSON.

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
| Model loops on large file writes; the chat shows "cut off mid-stream" nudges | Check the conversation's `settings.json` for the three timeout variables, then restart its CLI (Command-Q, `ccd`). `cli_byte_watchdog_fired` with `"idle_ms":300000` in `~/Library/Logs/Claude-3p/cli-diagnostics.jsonl` means the old 300 s limit is still active. |
| `Request timed out.` after about 6 minutes, then retries | Same cause: the non-streaming fallback still has Desktop's forced idle timeout. Apply the fix as above. |
| `Unrecognized backup; left untouched` in the helper log | The backup was written by an unknown helper version or edited by hand. Inspect it; the helper refuses to guess. |
| Unsure whether a Desktop update still needs or accepts the timeout settings | Run `node ./stream-timeout-harness.cjs` (about 7 minutes) and compare with the expected results below. |
| Context changes after a Desktop update | Recheck `/context` and the session-directory layout. This is a version-dependent workaround, not an official Desktop setting. |

## Restore or uninstall

Finish the active turn and quit Claude. If the helper has been used, run:

```zsh
ccd restore
```

Restore consumes its per-conversation backup records. It does not delete a
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
restore, version 1 backup migration, malformed JSON and backups, symlink
handling, watcher behavior and installation. Temporary watcher processes are
stopped and fixtures are removed afterward.

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
the stream-timeout harness against a local fake server. They do not send a model
prompt to your provider. A future runtime that changes these settings or its
output format may require an update to the checks and to this workaround.

### Stream-timeout harness

`stream-timeout-harness.cjs` reproduces the silent-stream cut-off offline and
verifies the fix with the real embedded CLI. It starts a fake Anthropic endpoint
on `127.0.0.1` that sends the first SSE events and then stays byte-silent, like
Ollama while it generates a long tool call. It runs the embedded CLI with
Desktop's own session environment (`API_FORCE_IDLE_TIMEOUT=1`,
`API_TIMEOUT_MS=900000`) and a temporary config directory. The `fix` scenario
uses the helper's own `configureSession`, so it checks exactly what `ccd` writes.
It does not read or change `~/.claude`, the `Claude-3p` profile, Ollama, or your
provider, and it removes its temporary files afterward.

```zsh
node ./stream-timeout-harness.cjs
```

The CLI is found automatically (newest under
`~/Library/Application Support/Claude-3p/claude-code`), or pass
`--cli /absolute/path`. The four scenarios run in parallel and take about
7 minutes. Expected results with Desktop 2.42304.0 and embedded CLI 2.1.299:

```text
control     CUT after 300.0s         Desktop defaults, silent gateway [byte watchdog fired after 300000 ms; stream failed: StreamIdleTimeoutError; non-streaming fallback started]
fix         SURVIVED 380s silence    settings written by ccd, silent gateway
ping        SURVIVED 380s silence    Desktop defaults, gateway sends SSE pings
streamonly  CUT after 360.xs         only CLAUDE_STREAM_IDLE_TIMEOUT_MS (Desktop "Stream idle timeout"), silent gateway [stream failed: TimeoutError; non-streaming fallback started]

OK: the settings written by ccd keep a byte-silent stream alive with this CLI build.
```

The exit status is non-zero only if the `fix` scenario is cut. If `control`
also survives a gap longer than 300 s, the Desktop build may no longer need the
timeout settings. Other options:

| Option | Purpose |
| --- | --- |
| `--silence-seconds N` | Length of the silent gap (default 380; above 360 s exercises both limits) |
| `--scenarios fix,control` | Run a subset |
| `--ping-seconds N` | Keep-alive interval for the `ping` scenario (default 15) |
| `--keep` | Keep the temporary configs and CLI diagnostics for inspection |

The `ping` scenario shows the alternative fix that needs no CLI settings: a
gateway or relay that sends SSE `ping` events while the model is silent.

## Compatibility notes

The working setup was first observed with Claude Desktop **2.26454.0** and its
embedded CLI **2.1.289** on macOS. The portable package was also exercised with
embedded CLI **2.1.293**, Node.js **26.5.0** and zsh **5.9**.

The stream-timeout settings (version 2) were diagnosed and verified with Claude
Desktop **2.42304.0**, embedded CLI **2.1.299**, the Ollama macOS app **0.40.6**
as Claude gateway in front of an Ollama **0.40.5** server running
`glm-4.7-flash` Q8 with a 131,072-token context, Node.js **26.5.0**, macOS
**26.6.2** and zsh **5.9**.

There is no Windows/Linux support in this launcher. Different session storage,
a nonstandard app installation path, a symlinked home/install layout, remote
Cowork or full-VM execution may require adaptation. Recheck the actual Cowork
`/context` result after installing on another Mac or updating Desktop, and rerun
the stream-timeout harness.

This helper does not make Ollama stream tool calls, change thinking mode,
guarantee an exact compaction trigger, or enforce a hard limit on a single
request. It only lets Desktop conversations wait up to 30 minutes for a silent
stream instead of 5.
