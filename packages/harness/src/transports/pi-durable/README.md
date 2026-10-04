# Pi on pi-durable

`PiDurableTransport` drives Pi as an embedded library: one `@earendil-works/pi-durable` `Harness` per Claxedo session, in the process that hosts the transport. There is no Pi CLI, no child process for the agent loop and no IPC. The same class serves two placements through `PiPlacement` (`placement.ts`): the local daemon (`node.ts`, `createNodePiPlacement`) and a Durable Object host that implements the port itself. `index.ts` and `placement.ts` import no Node built-in, so a Worker bundle can import `@claxedo/harness/pi-durable`; pi-ai's provider APIs (the Anthropic SDK) still reference Node built-ins, so a Worker host needs `nodejs_compat`.

## What one session holds

- **Storage.** The local placement keeps each session in `<stateRoot>/sessions/<sessionId>.sqlite` through pi-durable's portable `SqliteStorage`: under Node over pi-durable's own `node:sqlite` adapter, under Bun over `bun:sqlite` (`storage.ts`), because Bun has no `node:sqlite` and the workspace runtime runs under both, as its own store does. Pi's transcript is the only copy; the binding's `upstreamSessionId` is the session id and its root conversation id, unique across sessions, and attach refuses a store whose root is another one.
- **Registry.** Pi stores extension names, not code, so the transport installs the same extensions before `resume()` on every open: Pi's `CodingTools` (read, write, edit, bash) and the `claxedo` extension (`extension.ts`) with the `question` tool, the session's MCP tools, the `available_skills` section and the approval hook.
- **Models.** `PiCredentials` (`credentials.ts`) gives the session its own pi-ai `Models` over a credential store built from `ResolvedCredentials.direct`. Only direct rows reach Pi; broker placeholders and the machine's own logins never do, and the auth context is empty, so pi-ai reads no environment variable and no file such as `~/.pi`. Each built-in provider's auth is replaced: an API key resolves from the row, a subscription is an OAuth credential whose `toAuth` sends the access token and whose `refresh` asks the placement's `refreshCredential` and otherwise fails with `credential_expired`, so Claxedo's authority stays the one refresher. A row's `baseUrl` and `apiPath` become the request's base URL (Anthropic's SDK appends `/v1` itself, so it gets the origin). A custom provider definition becomes an OpenAI-compatible provider spending the row its `credentialProviderId` names; a definition that reuses a built-in id is not registered, because the built-in provider plus the row's base URL already reach it. The model catalog (`piCatalog`, for a session and for a draft) lists every provider the owner has a usable row for, direct or a brokered account row, so a cloud workspace's machine, which receives account rows but no direct ones, answers a Pi draft without holding a secret. A turn still needs a direct row: a model whose provider has none is refused before the turn with `direct_credential_required`. `configure({ credentials })` swaps the rows in place and answers `applied`; nothing restarts.
- **Environment.** Tools run through `HarnessOptions.env`. Locally that is pi-durable's `NodeExecutionEnv` for files, with its `exec` replaced by `shell.ts`, which starts every command through `HarnessServices.spawn`, so each bash call is an owned launch with a launch record and a process group. The command returns when its own shell statement exits; the shell then waits for the background jobs it started, and its group is retired when that shell exits, when the session closes, or when a Stop or timeout ends the command. Output beyond the bash tool's limits is not spilled to a file; the retained tail is the result.

## Turns

`send` refuses an attachment that is not an inline image before anything is submitted, applies the turn's model and thinking level with `conversation.configure`, claims the session stream with a `PiRun` and submits the prompt (`flattenTurnPrompt` with the system prefix) under a fresh request id. Pi deduplicates submissions by request id, and the shared conformance suite reuses turn ids, so the id is unique per send; Claxedo never resubmits a crashed turn, because Pi resumes the run itself.

`stream.ts` keeps one `watchEvents` stream per session and routes each commit's batch to its owner: nobody, the Claxedo turn in `send`, or a continuation provider turn. A run settles at the end of the batch that settles its submission, so the usage committed with the answer stays in the turn: `done` is `finish`, `unanswered` with reason `aborted` is `cancelled`, any other `unanswered` is the harness's own `error` with Pi's detail. A steer is submitted with `whenBusy: "steer"` under its own request id, and becomes `input-incorporated` for its Claxedo message when Pi places it.

| Pi event | Claxedo event |
|---|---|
| `message_start` / `message_update` / `message_end` of an assistant message | `text-delta`, `thinking-delta`; final content is reconciled against what streamed and a contradiction is refused |
| `message_end` with stop reason `length` | `harness-notice` `pi.output_limit` |
| `tool_execution_start` / `_update` / `_end` | `tool-start` + `tool-input`, `tool-content` for appended output, `tool-output` or `tool-error` |
| `usage_changed` | `usage`, the difference from the previous totals, reasoning taken out of output |
| `auto_retry_start` | `session-retry` |
| `compaction_start` / `compaction_end` | `session-compaction` |
| `task_failed` | `harness-notice` `pi.task_failed`; the turn ends with its submission |
| `snapshot` | baseline usage, and only the partial answer the stream had not shown |
| `run_*`, `turn_*`, `submission`, `inbox_update`, `agent_changed`, `entry_appended`, `auto_retry_end`, `deferred_poll` | nothing |
| anything else | one `debug` diagnostic per kind per session |

A model error Pi retries is `session-retry` and its failed attempt shows nothing. A context overflow makes Pi compact and retry once, with Pi's own compaction and retry defaults.

`cancel` aborts the conversation: queued inputs are withdrawn, every task of the run is aborted, and a running bash command's group is retired. It answers `terminal` once Pi is idle, or `cancellation_timeout` at the deadline.

## Requests

The `beforeTool` hook asks before `write`, `edit`, `bash` and every `mcp__` tool when the session's mode is `ask` (`PI_PERMISSION_MODES`; `full`, the default, never asks). It asks the active run's broker, or the session broker during a continuation, with request id `pi-tool:<toolCallId>` and the tool name as grant key, so a re-ask of the same call after a crash replays the saved answer. Allow runs the tool; anything else blocks it with a reason the model reads. The `question` tool asks the person through the broker and returns their answer as text; it is not replay-safe, so a crash mid-question gives the model an interrupted result.

## MCP and skills

`mcp.ts` builds one pi-mcp `McpClient` per server of `sessionMcpServers`, with Claxedo's first-party server for a local session only. It lists each server's tools when the extension is installed (cached by projection generation and server names) and calls them over the same client; a dropped client reconnects on the next call. Tool names are `mcp__<server>__<tool>`, reduced to `[A-Za-z0-9_]` within 64 characters with an FNV-1a suffix when they change. A server that fails to connect is reported as `mcp-server-status` `failed` and contributes no tools. Locally an HTTP server uses pi-mcp's `StreamableHttpTransport`, and a stdio server runs through `HarnessServices.spawn` (`mcp-stdio.ts`) with its own env over the standard MCP inherited set (`HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER`; the Windows equivalents), never the daemon's environment. SSE servers are refused (`harnessSupportsMcpServer`). The skills section lists each projected plugin skill's name, description and `SKILL.md` location, read through the section's environment, so it works wherever the tools run.

## Crash and resume

Pi commits a tool call's intent before executing it. When the process dies, reopening the store finds the live run: a `replay: "safe"` tool reruns and any other gets an `interrupted` error result, and the generation continues. The transport declares `durableRuns`; at boot the host attaches every session it interrupted, and the attach's stream sees the live run in its snapshot and admits it as a `continuation` provider turn, whose events and terminal are that turn's.

## Placement port

`PiPlacement.open` returns the session's `Harness`, root conversation and live registry, without resuming; the transport installs its extensions and resumes. `env` builds the execution environment, `mcpTransport` the transport for one server, `prepareTurn` (cloud) delivers the turn's credentials, projection and provider definitions before each turn, and `refreshCredential` renews an expiring subscription.

A cloud turn publishes its actual model and effort options through `config-update` after `prepareTurn` delivers credentials and the conversation accepts the model. A model read made before that delivery can be empty; the event replaces that earlier catalog without a reload or an invented model.

`model-catalog.ts` owns the conversation's durable model choices: model IDs, display names and supported effort levels, derived from the latest delivered credentials and definitions. Session configuration reads and validates against that document; drafts derive the same choices from their supplied account rows. Local open records its supplied catalog. Cloud open preserves the document until `prepareTurn` delivers credentials; an empty attachment outside a turn is not a revocation. An explicit credential update replaces the catalog, including clearing it when no providers remain. The document contains no credentials or endpoints and grants no execution authority: every turn still requires a newly delivered direct credential.

Reviewed transport budget: 1,698 production lines, exactly 43 more for the durable model-catalog owner and shared effort validation. Server Worker closure verification passed with this owner. No per-file size limit changed.
