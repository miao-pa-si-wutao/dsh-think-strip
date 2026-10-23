# dsh-think-strip

**Keep DeepSeek Harness conversations alive for hundreds of turns without paying for the same reasoning text twice.**

This plugin strips historical **reasoning blocks** and **oversized tool outputs** out of the model's context. Originals are archived to disk by timestamp with a searchable index; in their place the model sees a one-line summary (for reasoning) or a head/tail preview plus the archive path (for tool results).

Two per-session switches sit left of the chat composer — **thinking** and **tools** — and they are independent. New sessions follow configured defaults.

> Interface language: the plugin ships English and Chinese strings (`locale/en.json`, `locale/zh.json`). Documentation: [English](README.md) · [中文](README.zh.md)

---

## The problem

Every request DeepSeek Harness sends includes the full history: assistant `reasoning` blocks are replayed verbatim (no filter in `dsh-llm-deepseek`'s `assistant()`), and tool results are resent whole. Nothing is wrong with that per se — it is what makes an agent coherent. It is also what makes long sessions expensive and eventually impossible.

Measured on one real session (`session-f0b74f94`, 1101 tool results / 1118 assistant messages):

| Item | Value |
| --- | --- |
| Total tool-output characters | 2,163,722 |
| Tool results ≥ 4000 chars | 128 results, 1,426,922 chars (**66%** of all tool text) |
| Reasoning blocks | 776 blocks, 1,078,446 chars |
| `tool/result` content shapes | `text` × 1069, `text,image` × 32 |

A handful of large tool outputs dominate the budget. Strip those 128 results and you reclaim ~1.22M characters; strip the reasoning and you reclaim another ~1.08M. Neither number is a rounding error.

## What it guarantees

- **The append-only session log is never rewritten.** Originals stay in `session.v4.jsonl.zstd`, so fork / resume / replay behave exactly as before.
- **Prompt-cache prefixes survive.** Stripping happens mid-history, but once a strip is committed the message sequence is byte-stable, so prefix caching keeps hitting.
- **Nothing is lost.** Each stripped item is written as its own JSON file, indexed in `index.jsonl`, and the replacement text in context names the archive path — the model can go read it when it actually needs the detail.

## How it works

Two cooperating channels, neither of which touches the log:

1. `appendPluginRecord(session, 'plugin:think-strip', { targets, indexed })` — writes one `ignorable: true` plugin record. It never enters the surface nodes and survives a DSH restart.
2. `ctx.sessions.registerMessageProjection({ type: 'plugin:think-strip', project })` — registers the matching projection. On fold, the `seq`s named by the record are replaced with **frozen copies** (each keeps its original `message.id`).

Each entry in `targets` is `{ seq, kind, summary?, replacement? }`, where `kind` is `'reasoning'` or `'tool'`. **Records without a `kind` are read as `'reasoning'`**, so records written by v0.1 keep working and old sessions do not break on upgrade.

Timing: on `agent/turn-stopping` (the turn is closing and the model owes no reply) the plugin rescans **all** history, archives originals first, then commits a single record covering every target `seq`.

Rescanning everything rather than only the current turn matters: turns from before the plugin was enabled — or before a switch was flipped — have accumulated originals that would otherwise sit in context forever. Already-processed messages come back from `session.deriveEventMessage(event)` without their originals (the projection is applied), so they are skipped for free. `session.surface.nodes` doubles as a whitelist, skipping messages already hidden by compaction.

### Why not some other seam

| Candidate | Why it does not work |
| --- | --- |
| `agent/pre-step` to rewrite `messages` | That array holds only the user batch claimed for this step; history is not in it (`dsh-agent-loop/lib/index.js:902-927`, `this.inbox.claim(...)`) |
| Surface replace on `assistant/message` | Hard-rejected by the kernel: `assistant/message embeds its source stream and cannot carry sourceEventSeqs` |
| `llm/stream` waterfall mutating `options.messages` | The request is deep-frozen — "listeners read it, never rewrite it" |
| `agent/request` waterfall | Documented as unable to mutate messages |
| Plain `session.append()` with a custom type | A normal append cannot set `ignorable`; reopening the session rejects unknown events |
| The built-in `tool-result-pruner` | Broken in this DSH build: it reads `event.data.message.content[0].content` (assuming nesting) while the real shape is a flat `ContentBlock[]`, so `pruneContent(undefined)` throws. It is also `disabled: true` at `cordis.yml:321` |

## The two session switches

Two `role="switch"` buttons left of the composer:

- **Thinking** — whether this session strips historical reasoning content
- **Tools** — whether this session compresses oversized historical tool output

State is stored per `sessionId` in `<archiveDir>/switches.json`:

```json
{
  "defaults": { "reasoning": true, "tools": false },
  "sessions": { "session-f0b74f94": { "reasoning": false } }
}
```

Precedence: **session override > `defaults` > Config**. A switch only decides whether *this turn* commits new strip records; **records already committed keep applying forever** (the log cannot be rewritten — that is the design). To undo stripping for a session you must archive that session, or accept that it stays projected.

Query and update over HTTP (loopback only):

```powershell
# read
Invoke-RestMethod 'http://127.0.0.1:<DSH_WEB_PORT>/think-strip/state?sessionId=session-f0b74f94'

# turn off reasoning stripping for this session;
# tools:null clears the override and falls back to the default
Invoke-RestMethod 'http://127.0.0.1:<DSH_WEB_PORT>/think-strip/state?sessionId=session-f0b74f94' `
  -Method Post -ContentType 'application/json' -Body '{"reasoning":false}'
```

## Archive layout

```
<archiveDir>/
├── switches.json                    # per-session switches
├── index.jsonl                      # one index line per archived item
├── plugin.log                       # startup marker (did apply even run?)
└── <sessionId>/
    ├── 2026-10-20T10-33-24-123Z-t3-s1-q42.json      # reasoning
    └── 2026-10-20T10-33-24-456Z-tool-97.json        # tool output
```

One archived reasoning item:

```json
{
  "kind": "reasoning",
  "time": 1760950000000,
  "sessionId": "session-f0b74f94",
  "turn": 3,
  "step": 1,
  "seq": 42,
  "model": "deepseek-v4.1-flash",
  "chars": 2514,
  "summary": "User wants 1+1.",
  "reasoning": "(full original reasoning)",
  "text": "(the reply text for that message)"
}
```

One archived tool result:

```json
{
  "kind": "tool",
  "time": 1760950000000,
  "sessionId": "session-f0b74f94",
  "turn": 3,
  "step": 1,
  "seq": 97,
  "toolName": "pwsh",
  "chars": 49932,
  "summary": "pwsh output, 49932 chars",
  "text": "(full tool output)"
}
```

An index line:

```json
{"time":1760950000000,"sessionId":"session-f0b74f94","kind":"tool","turn":3,"step":1,"seq":97,"toolName":"pwsh","chars":49932,"summary":"pwsh output, 49932 chars","file":"session-f0b74f94/2026-10-20T10-33-24-456Z-tool-97.json"}
```

Searching it:

```powershell
# by keyword
Select-String -Path "$env:USERPROFILE\.dsh\think-archive\index.jsonl" -Pattern "some keyword"

# tool outputs only, largest first
Get-Content "$env:USERPROFILE\.dsh\think-archive\index.jsonl" |
  ForEach-Object { $_ | ConvertFrom-Json } |
  Where-Object { $_.kind -eq 'tool' } |
  Sort-Object chars -Descending |
  Select-Object -First 20
```

What the model sees in place of an oversized tool result:

```
(head N characters)
…[tool output archived]…
(full 49932 characters archived at: <DSH_HOME>\think-archive\session-xxx\2026-….json; read or grep it)
…(tail M characters)
```

It reads that file when it needs the detail. What is saved is the *indiscriminate* context cost, not the information.

## Install

From inside DSH:

```
plugin_manager action=install_bundle target=<absolute path to this package>
```

Or add it to the profile's `cordis.patch.yml` by hand:

```yaml
- insert:
    - id: dsh-think-strip
      name: 'dsh-think-strip'
```

The client half is declared by `package.json`'s `dsh.client.platform = "web"` plus `exports["./client"]`; the host injects it into the Web UI automatically.

## Configuration

Set it in the profile's `cordis.patch.yml`, overriding by id:

```yaml
- id: dsh-think-strip
  config:
    enabled: true
    archiveDir: ''
    archive: true
    summaryMode: first-line
    summaryMaxChars: 100
    minReasoningChars: 0
    keepSummary: true
    reasoningDefault: true
    toolsDefault: true
    toolStripChars: 4000
    toolHeadChars: 1200
    toolTailChars: 400
    trace: true
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. Off stops processing new turns; already-committed records still apply |
| `archiveDir` | `''` | Archive root; empty means `<DSH_HOME>/think-archive` |
| `archive` | `true` | Write originals to disk. Off strips without archiving (not recommended: items that fail to archive are not projected) |
| `summaryMode` | `first-line` | `first-line` takes the first line of the reasoning; `none` leaves only a `[reasoning archived]` stub |
| `summaryMaxChars` | `100` | Maximum summary length |
| `minReasoningChars` | `0` | Reasoning shorter than this is left alone |
| `keepSummary` | `true` | Insert a summary line where content was stripped |
| `reasoningDefault` | `true` | Default for sessions with no override |
| `toolsDefault` | `true` | Default for sessions with no override |
| `toolStripChars` | `4000` | Compress plain-text tool results longer than this; `0` compresses all |
| `toolHeadChars` | `1200` | Head characters kept after compressing |
| `toolTailChars` | `400` | Tail characters kept after compressing |
| `trace` | `true` | Write one line per turn to `plugin.log` — this is how you debug "why did nothing happen" |

## Caveats

- **The projection lives in the plugin.** Uninstalling it makes sessions that used it refuse to derive further (`session message projection "plugin:think-strip" was removed or replaced`). To uninstall, archive those sessions first or accept that they can no longer be opened.
- **One record per turn, not per step.** Multiple steps in a turn are covered by the same record.
- **Tool results are only processed when they are entirely `text` blocks.** Results containing images / files / structured blocks (32 of 1101 measured were `text,image`) are skipped whole — splitting image blocks risks more than it saves.
- **Content that fails to archive is not projected.** Those `seq`s stay in context with a warning logged — better to spend the tokens than to lose the original.
- When compaction replaces a span of history with a summary, the hidden `seq`s are no longer on the surface and the projection silently skips them.
- **Plugin records must contain no `undefined` values.** `Session.append` validates with `snapshotJsonValue`, which only accepts booleans / strings / finite numbers / plain objects / plain arrays; a single `undefined` throws `session event "…" carries non-JSON-serializable data` and the projection never commits (the archive is still written, but context is unchanged). Everything therefore goes through `toJsonSafe()` (`lib/pure.js`), which strips `undefined` keys via a JSON round-trip.
- **Changing plugin source requires a DSH restart.** Modules under `node_modules` do not participate in HMR; only config changes hot-apply.
- Lifecycle markers: `<archiveDir>/plugin.log` gets one line per `apply`; with `trace` on, each turn appends `turn=N sid=… sw=r1t1 ev=<events> sf=<surface nodes> targets=<hits> committed|targets=0|FAILED`, which separates "plugin never started" from "started but never fired" from "fired but matched nothing" from "matched but failed to commit".

## Tests

The pure logic layer (`lib/pure.js`) runs without Harness:

```powershell
cd dsh-think-strip
node --test test/pure.test.mjs
```

## License

MIT — see [LICENSE](LICENSE).
