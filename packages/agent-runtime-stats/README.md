# Agent Runtime Stats

Dependency-free Node.js CLI for analyzing local coding-agent transcripts and answering two questions:

1. What percentage of tool calls can run in a virtual Bash environment, and what percentage need a full workspace VM?
2. How much time passes before an agent needs a full workspace VM again?

Every discovered session is included.

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

Interactive scans show live file counts, elapsed time, and the active harness. The report adapts to wide, compact, and narrow terminals, with a minimum 30-column layout, while printing the runtime split, VM action buckets, and the median and p95 reasoning/editing gap from one VM-required call finishing until the next starts in the same agent turn. `--format json` prints the same model as formatted JSON for automation.

The report also measures the local execution-demand pattern:

- Sessions with observed execution calls, split into full-machine and just-bash-only sessions; discovered sessions with no readable execution calls remain separate.
- Median and p95 full-machine calls per session that requires one.
- Median and p95 lead time from the first timestamped execution call to the first full-machine call in the same agent turn.
- Median and p95 duration of full-machine calls with observed start and completion timestamps.
- Median and p95 time between full-machine calls in the same turn when the preceding call or overlapping call cluster has an observed completion.
- The count and percentage of measured gaps longer than 30, 60, and 120 seconds.

These are local demand measurements only. The report does not estimate sandbox provisioning, workspace synchronization, cache restoration, service startup, or total environment-readiness time; those require telemetry from the execution platform.

Table output also prints a browser share link. The aggregate report is encoded in the URL fragment, which browsers do not send in the request. Nothing is uploaded until the user reviews the summary and presses **Share results** on the page. The resulting public URL includes a generated social preview image for X and other Open Graph consumers. Set `AGENT_RUNTIME_STATS_SHARE_URL` to point local builds at another compatible share service.

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

The two headline tiers are mutually exclusive and represent the minimum sufficient runtime:

- **just-bash:** calls that can be powered by [Vercel Labs' just-bash](https://github.com/vercel-labs/just-bash), including file operations, patches, text search, shell utilities, JavaScript, configured HTTP/API requests, and emulated host bindings.
- **Full workspace VM:** package/dev runners, local Git state, interactive processes, local browser testing, and native executables.

Control-plane calls such as planning, subagent coordination, waiting, and task/thread management are excluded from the execution-call denominator.
