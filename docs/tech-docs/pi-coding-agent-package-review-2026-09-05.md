# `@mariozechner/pi-coding-agent` v0.73.1: package review

Review note (2026-09-05): this is the supplied package research, not runtime acceptance evidence. [Revised plan 002](../plans/2026-09-05-002-pi-worker-runtime-and-gateway-plan.md) governs implementation. The Worker extension-API/dispatch reuse suggestions below are superseded: code extensions are Sandbox-only. Forks copy native history, while context reconstruction applies compaction; copying a file alone does not implement durable continuation or promotion. This review did not reproduce the full module counts, release-cadence claims or bundle spikes; retain exact source manifests and reproducible commands before using those estimates as gates.

Date: 2026-09-05. Source: the `earendil-works/pi` monorepo at tag `v0.73.1`, `packages/coding-agent`. Every claim below was read from source in that checkout. Line counts are `wc -l` of `.ts` files.

Companion plan: [Pi worker runtime and credential gateway on workerd](../plans/2026-09-05-002-pi-worker-runtime-and-gateway-plan.md). Section 12 of this document maps each module to that plan.

## 1. Identity

| Fact | Value |
|---|---|
| Version | 0.73.1, released 2026-05-07, three days after 0.73.0. Patch releases land every few days. |
| Binary | `pi` at `dist/cli.js`. A Bun-compiled binary variant exists under `src/bun/` with its own entry, Bedrock registration and an env workaround for a Bun bug. |
| Exports | `.` and `./hooks`. The `./hooks` export points at `dist/core/hooks/index.js`, and no `src/core/hooks` directory exists. It is a dead export left from the hooks-to-extensions rename. |
| Dependencies | `pi-agent-core`, `pi-ai`, `pi-tui`, plus `jiti`, `diff`, `glob`, `ignore`, `minimatch`, `proper-lockfile`, `photon-node` (image resize), `extract-zip`, `hosted-git-info`, `marked`, `cli-highlight`, `yaml`, `uuid`. |
| Tests | 126 files under `test/`, run with `vitest --run`. A test harness wires a real `AgentSession` with in-memory dependencies and a faux stream function that scripts assistant responses. Repo rules forbid real provider calls in tests. |
| Rename pending | The changelog says the package will move to `@earendil-works/pi-coding-agent`. Our pin must follow that rename. |
| White-label hooks | `config.ts` reads `piConfig.configDir` and an app name from the package manifest, and `PI_CODING_AGENT_DIR` plus `PI_CODING_AGENT_SESSION_DIR` override the agent and session directories. The config directory name, app name and title are all derived from those, so a rebranded config dir is a supported path, not a fork. |

## 2. Module map

| Area | Files | Lines | Purpose | Node coupling |
|---|---|---|---|---|
| `src/core` top level | 32 | ~14,000 | `AgentSession` (3,110), `SessionManager` (1,425), `SettingsManager` (1,067), `ModelRegistry` (952), `DefaultResourceLoader` (918), `package-manager` (2,428), `model-resolver` (636), `auth-storage` (524), `skills` (504), `sdk` (413), `agent-session-runtime` (409), `system-prompt` (172), `messages` (195), `bash-executor` (156), `exec` (107), `keybindings` (370), `footer-data-provider` (354), `export-html/` (3 files) | Heavy. Session files, settings and auth are file based with locks. Resource discovery walks directories. |
| `src/core/tools` | 15 | ~3,500 | read, bash, edit, write, grep, find, ls, truncation, output accumulator, file mutation queue, path utils, definition wrapper | Each tool has a pluggable `*Operations` seam. Defaults spawn processes and use `fs`. |
| `src/core/extensions` | 5 | ~3,400 | `types.ts` (1,567: the `ExtensionAPI` contract and every event type), `loader.ts` (605: jiti loader and API object construction), `runner.ts` (1,068: event dispatch and contexts), `index.ts`, `event-bus.ts` | Loader is Node only. Runner imports the interactive theme module for its default UI context and `pi-tui` key types. |
| `src/core/compaction` | 4 | ~1,400 | auto-compaction, branch summarization, shared serialization | Pure logic except the summarization call, which calls `pi-ai` directly. |
| `src/modes/interactive` | 38 | 16,072 | The TUI: 36 components, theme, editor, selectors | Terminal only. |
| `src/modes/rpc` | 4 | ~1,200 | JSONL command protocol over stdin and stdout, extension UI bridge | Node stdio. |
| `src/modes/print-mode.ts` | 1 | | `pi -p` text and JSON output | Node stdio. |
| `src/cli` | 6 | 711 | Argument parsing, file arguments, initial message, session picker, model listing | Node. |
| `src/utils` | 19 | 2,129 | child processes, clipboard, images, git URLs, paths, shell sanitizing, version check, `tools-manager` | Node. `tools-manager.ts` downloads `rg` and `fd` release binaries from GitHub into the agent bin dir when they are not on the system. |
| `src/main.ts`, `config.ts`, `migrations.ts` | 3 | ~1,550 | CLI entry, directory and path resolution, one-time on-disk migrations | Node. |

## 3. Composition: how a session comes to exist

`createAgentSession(options)` in `sdk.ts` is the SDK entry. In order:

1. Resolve `cwd`, `agentDir`, `AuthStorage` (auth.json), `ModelRegistry` (built-in catalog plus models.json), `SettingsManager` (global and project settings deep merged), and `SessionManager` (a session file under the encoded cwd directory, or the one passed in).
2. If no `ResourceLoader` was passed, construct `DefaultResourceLoader` and `reload()` it, which discovers and loads everything in section 7.
3. Build the session context from the session manager. If the session already has messages, restore the model from the recorded model change or last assistant message, and restore the thinking level. Otherwise fall back to settings defaults and the first available model with configured auth.
4. Construct the `pi-agent-core` `Agent` with: an empty system prompt (set later), `convertToLlm` wrapped to strip images if `blockImages` is on, a `streamFn` that resolves the API key and headers from the model registry per call and calls `streamSimple` with retry settings and attribution headers, `onPayload` and `onResponse` that forward to the `before_provider_request` and `after_provider_response` extension events, `transformContext` that forwards to the `context` extension event, and steering, follow-up, transport and thinking budgets from settings.
5. If the session has history, set `agent.state.messages` from the rebuilt context. Otherwise append model and thinking-level change entries so a fresh session records them.
6. Construct `AgentSession`, which subscribes to agent events, installs `beforeToolCall` and `afterToolCall` hooks that forward to the `tool_call` and `tool_result` extension events, and calls `_buildRuntime` to create base tool definitions, construct the `ExtensionRunner`, bind the runtime actions, and build the tool registry and system prompt.

`createAgentSessionRuntime` wraps this in `AgentSessionRuntime`, which owns the session and its cwd-bound services and implements session replacement: `switchSession`, `newSession`, and fork. Replacement emits `session_before_switch` or `session_before_fork`, then `session_shutdown`, disposes the old session, creates a fresh runtime for the target cwd, and rebinds the host UI. `AgentSessionServices` is the set that is recreated whenever the effective cwd changes: auth storage, settings, model registry, resource loader.

`main.ts` parses flags, decides the mode (`rpc`, `json`, print, or interactive), builds the runtime, and dispatches to `runRpcMode`, `runPrintMode`, or `InteractiveMode`.

## 4. The turn: `AgentSession.prompt()`

Read from `agent-session.ts` lines 967 to 1145.

1. If the text starts with `/` and an extension registered that command, run the command handler with an `ExtensionCommandContext` and return. Extension commands run even while streaming.
2. If any extension registered `input`, emit it. The handler can mark the input handled, or transform the text and images.
3. Expand `/skill:name args` to the skill file content wrapped in a `<skill>` block, then expand `/template args` through prompt templates.
4. If the agent is streaming, the caller must have passed `streamingBehavior`. `steer` queues for delivery after the current tool batch; `followUp` queues until the agent stops. Otherwise throw.
5. Flush pending user-bash messages into the transcript.
6. Validate that a model is selected and has configured auth. OAuth providers get a distinct re-login error.
7. Run a compaction check against the last assistant message, so an aborted or overflowed previous turn is compacted before sending.
8. Build the message list: the user message, then any pending "next turn" custom messages queued by extensions.
9. Emit `before_agent_start`. Handlers can add custom messages and replace the system prompt for this turn. If no handler replaced it, reset to the base system prompt.
10. Call `agent.prompt(messages)`, then `waitForRetry()`.

Agent events are processed through a serialized promise queue in `_handleAgentEvent`. For each event: forward to extensions, notify listeners, then persist. `message_end` for user, assistant and toolResult roles appends a message entry. Custom messages append a custom message entry. On `agent_end`, if the last assistant message matched the retryable error regex (overloaded, rate limit, 5xx, network, timeout), retry with backoff up to the settings maximum. Otherwise run the auto-compaction check.

Two details matter for any port:

- `message_end` handlers may return a replacement message with the same role. `_replaceMessageInPlace` then mutates the original object in place, because `pi-agent-core` has already stored that object reference in its state and persistence reads `event.message` later. Identity, not value, is the coupling.
- `tool_call` handler errors propagate and block the tool. Every other extension event catches handler errors and reports them through `emitError`.

## 5. Persistence: `SessionManager`

Sessions are JSONL files under `<agentDir>/sessions/--<cwd with separators replaced>--/<timestamp>_<uuidv7>.jsonl`. The first line is a header with version, id, timestamp, cwd and optional parent session path. Every other line is an entry with `type`, `id` (8 hex characters, collision checked), `parentId`, and `timestamp`. Entries form a tree. The manager keeps a `leafId` and appends new entries as children of the leaf.

Entry types: `message` (user, assistant, toolResult, custom, bashExecution), `thinking_level_change`, `model_change`, `compaction`, `branch_summary`, `custom` (extension state, never sent to the model), `custom_message`, `label`, `session_info` (display name).

`buildSessionContext(entries, leafId)` walks from the leaf to the root, picks up the latest thinking level and model, finds the most recent compaction on that path, and emits: the compaction summary as a synthetic message, kept entries from `firstKeptEntryId` up to the compaction, then everything after it. Without a compaction it emits the whole path. This function is the single definition of what the model sees.

Persistence is lazy. `_persist` writes nothing until the session contains at least one assistant message. Until then entries accumulate in memory and are flushed together on the first assistant message. A session that never gets a reply never reaches disk.

Branching: `branch(id)` moves the leaf; `branchWithSummary` appends a branch summary entry generated by branch summarization; `createBranchedSession` writes a new file containing only the root-to-leaf path; `forkFrom` copies a session from another cwd. `SessionManager.inMemory()` disables persistence. `open()` reads the header cwd and asserts the cwd exists on resume.

Migrations run on load: v1 linear files get ids and parent links, v2 renames the `hookMessage` role to `custom`. Current version is 3.

## 6. Compaction

Settings: enabled by default, `reserveTokens` 16,384, `keepRecentTokens` 20,000.

Triggers: threshold (`contextTokens > contextWindow - reserveTokens`, where context tokens come from the last assistant usage or an estimate when the last message was an error), overflow (the provider returned a context overflow error, in which case the error message is dropped from state, compaction runs, and the prompt is retried exactly once), and manual `/compact [instructions]`. Compaction is skipped if the assistant message predates the latest compaction entry or came from a different model than the current one.

Algorithm in `prepareCompaction`: find the previous compaction on the path and start the summarization span at its `firstKeptEntryId`, not after the compaction entry, so kept messages get re-summarized. Walk backwards from the newest entry accumulating estimated tokens until `keepRecentTokens`, then choose the nearest valid cut point at or after that entry. Valid cut points are user messages, assistant messages, bash execution messages and custom messages, never tool results. If the cut lands mid-turn, it is a split turn and the turn prefix gets its own summary merged with the history summary. File operations read and modified are extracted from tool calls and previous compaction details and appended to the summary.

The `session_before_compact` extension event can cancel or supply the whole compaction result. `session_compact` fires after the entry is appended.

The summarization calls in `generateSummary` and `generateTurnPrefixSummary` call `pi-ai`'s `completeSimple` directly with an API key and headers obtained from the model registry. They do not go through the `Agent`'s `streamFn`. Any host that routes model traffic through a proxy or gateway must re-implement these two functions against that gateway, or the compaction call will bypass it.

## 7. Resources: `DefaultResourceLoader`

`reload()` runs in this order:

1. Reload settings.
2. Ask the package manager to resolve every configured source. Sources come from global settings, project settings, and explicit CLI paths, and each is npm (`npm install -g` globally or into `.pi/npm` for a project), git (cloned under the agent or project git dir, with `npm install` if it has a manifest), or a local path. A package declares extensions, skills, prompts and themes in a `pi` manifest key or by conventional directories, and settings can filter which resources of a package are enabled.
3. Load extensions from the enabled paths through `loadExtensions`, then inline `extensionFactories`. Conflicts between extensions on tool, command or flag names are diagnostics, not errors, and load order wins.
4. Load skills, prompt templates and themes from the enabled paths plus the agent dir and project dir defaults. Skills are `SKILL.md` files with frontmatter name, description, and `disable-model-invocation`. They are rendered into the system prompt as an `<available_skills>` block that tells the model to read the file with the read tool. Prompt templates are files invoked as `/name args` with positional substitution.
5. Load context files: `AGENTS.md` or `CLAUDE.md` in the agent dir, then every ancestor directory of the cwd from the root down.
6. Resolve a system prompt file and append-system-prompt files from the agent or project dirs.

Every override in `DefaultResourceLoaderOptions` (`extensionsOverride`, `skillsOverride`, `promptsOverride`, `agentsFilesOverride`, `systemPromptOverride`) is a function over the discovered base, and `noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes`, `noContextFiles` switch discovery off. The `ResourceLoader` interface is eight methods, so a host that already knows its resources can implement it directly and skip the filesystem walk entirely.

## 8. Extensions

An extension is a module whose default export is `(pi: ExtensionAPI) => void | Promise<void>`. The loader imports it with `jiti` (aliasing the Pi packages to the bundled copies, or using virtual modules in the Bun binary), creates an empty `Extension` record (handlers, tools, message renderers, commands, flags, shortcuts), builds the `ExtensionAPI` object, and calls the factory.

`ExtensionAPI` is a plain object. Registration methods write into the `Extension` maps. Action methods delegate to a shared `ExtensionRuntime`, which is created with throwing stubs and completed by `ExtensionRunner.bindCore` with the session's real actions. `exec` is the only method that touches Node directly, through `execCommand`. Everything else is host-neutral by construction.

The events, from `types.ts`: `resources_discover`, `session_start`, `session_before_switch`, `session_before_fork`, `session_before_compact`, `session_compact`, `session_shutdown`, `session_before_tree`, `session_tree`, `context`, `before_provider_request`, `after_provider_response`, `before_agent_start`, `agent_start`, `agent_end`, `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `model_select`, `thinking_level_select`, `tool_call`, `tool_result`, `user_bash`, `input`.

Dispatch semantics in `runner.ts`: handlers run sequentially across extensions in load order. `tool_call` returns the first blocking result. `tool_result` lets handlers replace content, details and error flag. `message_end` lets handlers replace the message if the role matches. `before_agent_start` threads the system prompt through handlers and collects extra custom messages. `context` gives each handler a structured clone of the messages. `user_bash` returns the first handler result. `input` can handle or transform.

Contexts: `ExtensionContext` exposes `ui`, `hasUI`, `cwd`, `sessionManager`, `modelRegistry`, `model`, `isIdle`, `signal`, `abort`, `hasPendingMessages`, `shutdown`, `getContextUsage`, `compact`, `getSystemPrompt`. `ExtensionCommandContext` adds `waitForIdle`, `newSession`, `fork`, `navigateTree`, `switchSession`, `reload`. Exposing the session manager and model registry to extensions means an extension can read the whole tree and register providers.

UI: `ExtensionUIContext` has about thirty methods. The runner's default is a no-op context whose `theme` getter imports the interactive theme module. The RPC mode implements the subset `select`, `confirm`, `input`, `editor`, `notify`, `setStatus`, `setTitle`, `setWidget` by emitting `extension_ui_request` lines and waiting for `extension_ui_response`, with timeouts resolving to defaults. Everything else is terminal only.

Tools registered by extensions are `ToolDefinition`s: name, label, description, optional `promptSnippet` and `promptGuidelines` that feed the system prompt, a TypeBox parameter schema, optional `prepareArguments` shim, optional execution mode, `execute(toolCallId, params, signal, onUpdate, ctx)`, and optional terminal renderers. `wrapToolDefinition` adapts one to a `pi-agent-core` `AgentTool`.

Reload: `session.reload()` emits `session_shutdown` with reason reload, reloads settings, resets the global API provider registry, reloads resources and rebuilds the runtime, preserving flag values.

## 9. Tools

Seven tools, each built from a factory that takes `cwd` and options with an `operations` object:

- **bash**: spawns the configured shell in a detached process group, streams stdout and stderr into an `OutputAccumulator`, throttles `onUpdate` calls, truncates to 2,000 lines or 50 KB whichever first, and writes the full output to a temp file when truncated. A `commandPrefix` from settings is prepended to every command. A `spawnHook` can rewrite command, cwd and env. Abort and timeout kill the whole process tree. `BashOperations.exec` is the seam.
- **edit**: one or more exact-text replacements against the original file in a single call, each unique and non-overlapping. Matching normalizes trailing whitespace, smart quotes, Unicode dashes and spaces for a fuzzy fallback, preserves CRLF, and returns a unified diff and first changed line. A legacy `oldText`/`newText` shape is accepted through `prepareArguments`. `EditOperations` is read, write, access.
- **read**: file or image, with optional auto-resize of images through photon. `ReadOperations` is read, access, MIME detection.
- **write**: create or overwrite. **grep**, **find**, **ls**: honor ignore files and call `rg` and `fd`, which `tools-manager` downloads from GitHub releases if absent. Each has an operations seam.
- `withFileMutationQueue` serializes edit and write on the same path.
- User-typed `!command` goes through `AgentSession.executeBash`, is recorded as a `bashExecution` message, and can be intercepted by the `user_bash` event.

The system prompt in `system-prompt.ts` lists tools only when they have a `promptSnippet`, adds guidelines depending on which tools are present, embeds absolute paths to the package's README, docs and examples so the model can read Pi's own documentation, appends context files under a Project Context heading, appends the skills block if the read tool is active, and ends with the date and working directory.

## 10. Models, auth and settings

`ModelRegistry` merges the generated catalog from `pi-ai` with `models.json`, which can add providers (with `baseUrl`, `api`, `apiKey` as a value or a command, `authHeader`, `headers`, OpenRouter and Vercel routing preferences) and models. Validation uses TypeBox. `getApiKeyAndHeaders(model)` resolves the key from auth storage first, then the provider config, and merges model, provider and per-model headers. Extensions can register or unregister providers at runtime.

`AuthStorage` holds `auth.json` with api key or OAuth credentials per provider. `getApiKey` checks runtime overrides, then stored credentials, refreshing OAuth tokens under a `proper-lockfile` lock so concurrent Pi processes do not race, then environment variables, then a fallback resolver. The OAuth providers themselves (Anthropic, OpenAI Codex, GitHub Copilot) live in `pi-ai`.

`SettingsManager` deep merges global and project settings, both written under file locks. The schema covers model defaults, transport, steering and follow-up modes, theme, compaction, branch summary, retry, shell path and command prefix, npm command, packages and resource paths, terminal and image settings, enabled model patterns, thinking budgets, markdown and warning options, and session dir. Install telemetry defaults to on and pings after an update is detected.

## 11. Modes

- **Interactive**: the 16,000-line TUI. It binds the real UI context to the extension runner, owns the editor, selectors, tree navigation, login dialogs, and renders tool output through per-tool renderers.
- **RPC**: commands `prompt`, `steer`, `follow_up`, `abort`, `bash`, `abort_bash`, `abort_retry`, `compact`, `set_auto_compaction`, `set_auto_retry`, `set_model`, `cycle_model`, `get_available_models`, `set_thinking_level`, `cycle_thinking_level`, `set_steering_mode`, `set_follow_up_mode`, `set_session_name`, `get_state`, `get_messages`, `get_session_stats`, `get_last_assistant_text`, `get_commands`, `get_fork_messages`, `new_session`, `switch_session`, `fork`, `clone`, `export_html`, `extension_ui_request`, `extension_ui_response`, `response`. Framing is strict LF-delimited JSONL. `prompt` responds when accepted; failures after acceptance arrive as events. It takes over stdout so nothing else can write to it.
- **Print**: send prompts, print the final text or every event as JSON, exit.
- **Export**: render a session file to HTML.

## 12. Findings that matter for the worker plan

1. **The compaction model call bypasses `streamFn`.** `generateSummary` calls `completeSimple` with a raw API key. The worker must implement summarization against the gateway. Everything else in `compaction.ts` and `utils.ts` is pure and portable.
2. **`buildSessionContext` and the entry types are the contract to keep.** They define what the model sees and what a session file is. The worker's SQLite rows should serialize to exactly these entries so export to a `.jsonl` is a query. The module imports `fs` at the top for the manager class, so the pure functions need to be extracted or the file split for a workerd bundle.
3. **`ExtensionAPI` is host-neutral except `exec`.** The object built in `createExtensionAPI` only delegates. A worker extension host can implement the same object over RPC, keep the same event list and the same dispatch rules from `runner.ts`, and treat `exec` as a machine request. `runner.ts` itself imports the interactive theme and `pi-tui` types, so the port copies the dispatch functions rather than importing the module.
4. **The RPC UI subset is the web UI contract.** `select`, `confirm`, `input`, `editor`, `notify`, `setStatus`, `setTitle`, `setWidget` already have request and response shapes. Reuse those shapes.
5. **Process-global state makes one Pi per tenant per process the only safe layout.** The API provider registry, OAuth provider registry, theme singleton, stdout takeover in RPC mode, tracked detached child pids and `resetApiProviders()` on reload are all module globals. Two tenants in one Node process would share provider registrations and credentials. This settles the sandbox side: one Pi process per session or per tenant, never a shared Node host.
6. **Persistence is lazy until the first assistant message.** A host that mirrors Pi's file writes must not assume a user message is on disk. The worker owns its own persistence and should write every entry immediately.
7. **`tool_call` errors block, other handler errors are swallowed.** The worker's RPC hook boundary must preserve this asymmetry or extension behavior changes.
8. **Tools download binaries from GitHub at first use.** `rg` and `fd` are fetched into the agent bin dir unless present. Sandbox images must ship them, and `PI_OFFLINE=1` disables the fetch. The same applies to install telemetry, which should be off in our images.
9. **The system prompt embeds host filesystem paths.** Package README, docs and examples paths are written into every prompt. In a sandbox that is fine. In the worker the prompt builder is ported without them.
10. **White-label configuration exists.** Config dir name, app name and title come from the package manifest, and the agent dir comes from an environment variable. Sandbox images can point Pi at a Claxedo-owned directory without patching.
11. **Release cadence is fast and the extension contract is large.** 1,567 lines of types change across patch releases. Pin exactly, and make the worker's extension conformance suite run against the pinned version so a bump is a measured event.
12. **Skills, prompt templates and context files are pure data at the prompt layer.** Discovery is filesystem based, but formatting into the system prompt and expansion of `/name args` are pure functions. The worker loads these from its own store and reuses the formatting.

### Reuse map

| Module | Sandbox placement | Worker placement |
|---|---|---|
| `AgentSession`, `AgentSessionRuntime`, `sdk.ts` | Used as is through RPC mode | Not used; the supervisor is the equivalent |
| `SessionManager` entry types, `buildSessionContext`, migrations | Used as is | Port the types and the pure functions; storage is SQLite |
| `compaction/*` | Used as is | Port everything; re-implement the two summarization calls over the gateway |
| `extensions/types.ts` | Used as is | Import the types; implement the API object over RPC |
| `extensions/runner.ts` dispatch | Used as is | Copy dispatch semantics without the TUI imports |
| `extensions/loader.ts`, `package-manager.ts`, `resource-loader.ts` | Used as is | Not used; the agent-extensions pipeline and a store-backed `ResourceLoader` replace them |
| `tools/*` schemas, descriptions, prompt snippets, truncation | Used as is with local operations | Reuse schemas and text; implement operations over `SessionEnv` |
| `system-prompt.ts`, `skills.ts` formatting, `prompt-templates.ts` expansion, `messages.ts` | Used as is | Port without the package path references |
| `model-registry.ts`, `auth-storage.ts`, `settings-manager.ts` | Used as is, pointed at a Claxedo-owned agent dir | Not used; the gateway and session record hold this |
| `modes/rpc` | The transport | Not used |
| `modes/interactive`, `export-html`, `cli`, `utils` | Present in the image, unused by Claxedo | Not used |
