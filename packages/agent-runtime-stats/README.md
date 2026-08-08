# Agent Runtime Stats

Dependency-free Node.js CLI for analyzing local coding-agent transcripts and answering four placement questions:

1. What percentage of whole sessions and agent turns complete without a full machine?
2. Once a turn needs a full machine, how often does it need that machine again?
3. How much observed execution remains after the first full-machine need?
4. What percentage of individual calls cannot be classified honestly?

Every discovered session is reported. The analyzed-session sample includes only sessions with at least one observed execution call.

```sh
npx @claxedo/agent-runtime-stats
```

For a local checkout:

```sh
npx ./packages/agent-runtime-stats
```

The same JavaScript package runs on macOS, Linux, and Windows, on both ARM64 and x64. It requires Node.js 22.13 or newer and has no native binaries, compiler requirement, post-install scripts, or runtime dependencies. SQLite support uses Node's built-in read-only SQLite API.

## Options

```text
--harness codex,claude,grok
--path codex=/custom/transcripts
--home /custom/home
--format table|json
--list-harnesses
```

Interactive scans show live file counts, elapsed time, and the active harness. The report preserves a bordered table in wide, compact, and narrow terminals, then renders definitions and caveats as spaced, labeled notes with restrained terminal colors. Set `NO_COLOR` to disable ANSI styling. The terminal table is deliberately limited to the placement decision, runtime split, full-machine causes, and on-demand timing. Every selected source and any read warnings or errors remain visible below it. `--format json` prints the complete analysis model, including diagnostics omitted from the terminal summary.

The report also measures the local execution-demand pattern:

- Sessions with observed execution calls, split into full-machine, just-bash-only, and unresolved-runtime-only sessions; discovered sessions with no readable execution calls remain separate.
- Turns with stable IDs, split into full-machine, just-bash-only, and unresolved-runtime turns.
- The share of full-machine turns that issue another full-machine call.
- Median execution-call count and median/p95 observed execution span after the first full-machine call in a turn. The observed span ends at the last timestamped execution call, not at the true end of the agent turn.
- Median and p95 full-machine calls per session that requires one.
- Median and p95 lead time from the first timestamped execution call to the first full-machine call in the same agent turn.
- Median and p95 duration of full-machine calls with observed start and completion timestamps.
- Median and p95 time between full-machine calls in the same turn when the preceding call or overlapping call cluster has an observed completion.
- The count and percentage of measured gaps longer than 30, 60, and 120 seconds.

These are local demand measurements only. The report does not estimate sandbox provisioning, workspace synchronization, cache restoration, service startup, or total environment-readiness time; those require telemetry from the execution platform.

Table output links to Claxedo's browser review page. The thirteen aggregate placement metrics are encoded in the URL fragment, which browsers do not send in the request. Nothing is uploaded until the user reviews the summary and presses **Publish anonymous snapshot** on the page. The resulting `claxedo.com/r/:id` URL includes a generated social preview image for X and other Open Graph consumers. Set `AGENT_RUNTIME_STATS_SHARE_URL` to use another compatible deployment.

## Harness coverage

| Harness     | Local source                                                                             | Coverage                                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Codex       | `~/.codex/sessions`, `~/.codex/archived_sessions`                                        | Tool names, inputs, start/end timestamps, turns, parent sessions                                         |
| Claude Code | `~/.claude/projects`                                                                     | `tool_use`/`tool_result`, timestamps, turns                                                              |
| Cursor ACP  | `~/.cursor/acp-sessions/*/store.db`                                                      | Detects JSON messages; reports partial coverage for proprietary protobuf tool records                    |
| Grok CLI    | `~/.grok/sessions/**/updates.jsonl`                                                      | ACP tool calls, inputs, completion timestamps                                                            |
| Kimi CLI    | `~/.kimi/sessions/**/context*.jsonl`                                                     | OpenAI-compatible tool calls; full-machine interval requires timestamps present in the installed version |
| Pi          | `~/.pi/agent/sessions`                                                                   | Tool-call/result blocks and timestamps                                                                   |
| Gemini CLI  | `~/.gemini/tmp/**/chats/*.json`                                                          | OpenAI-compatible local chat records                                                                     |
| Antigravity | `~/.gemini/antigravity-ide/conversations`                                                | Detection only; partial because the local format is schema-less protobuf                                 |
| OpenCode    | `$XDG_DATA_HOME/opencode/opencode*.db`, otherwise `~/.local/share/opencode/opencode*.db` | Sessions and tool parts through Node's read-only SQLite API                                              |

Absent and partially readable stores are reported explicitly; they are not silently treated as zero-call sessions. SQLite stores are opened read-only.

## Classification

The three headline tiers are mutually exclusive:

- **just-bash:** every resolved command segment is present in [Vercel Labs' just-bash](https://github.com/vercel-labs/just-bash) Node-hosted command manifest, assuming configured and allowlisted network access. File tools and explicit host capabilities are also included.
- **Full workspace VM / isolation boundary\*:** package/dev runners, local Git state, interactive processes, local browser testing, native executables, and generated code execution.
- **Unknown:** the tool or executable cannot be resolved from the persisted transcript. Unknowns are never folded into either headline tier; the report prints classified coverage.

\* Generated code execution is deliberately counted as full-machine because running agent-generated code crosses the isolation boundary, even when an optional just-bash runtime exists.

Control-plane calls such as planning, subagent coordination, waiting, and task/thread management are excluded from the execution-call denominator across Codex, Claude Code, and OpenCode naming conventions.

The Cloudflare Worker, D1 migrations, report site, and social-image renderer live in this package under `worker/`; deployment commands are documented in `worker/README.md`.
