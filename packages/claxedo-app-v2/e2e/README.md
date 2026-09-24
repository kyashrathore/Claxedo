# End-to-end tests

The suite runs the real app against the real daemon and runtime. The only fakes sit at external boundaries: a scripted model endpoint (what the real Claude Code, Codex and Pi processes call instead of api.anthropic.com / api.openai.com) and a scripted ACP agent (a small process speaking ACP over stdio). Nothing in production code knows it is under test.

## Running

```sh
bun run e2e -- --app=v2                      # every flow, v2, both projects (web + phone)
bun run e2e -- --app=v1                      # the same flows against today's app (baseline flows only)
bun run e2e -- --app=v2 --project=phone      # 390×844, touch
bun run e2e -- --app=v2 e2e/flows/00-harness-smoke.spec.ts
CLAXEDO_E2E_RED=1 bun run e2e -- --app=v2    # red run: the ACP agent fails every turn, model keys stay on the vendors' hosts
```

`--app` picks which package the daemon serves: `v1` is `packages/claxedo-app`, `v2` is this package. Global setup builds `packages/agent-sdk-runtime`'s launch gate child when it is missing (and `@claxedo/helpers` first, which that bundle needs), reserves the daemon port for the run (the first free port in `CLAXEDO_E2E_PORT_RANGE`, default 46100–46199, or `CLAXEDO_E2E_DAEMON_PORT`), then builds the chosen app into its `dist-e2e/` with `VITE_CLAXEDO_SERVER_URL` set to that daemon, the way a deployed bundle knows its server. The build is reused until a source file is newer than the stamp or the port changes (v2 builds in about 1.5 s; v1 in about 14 s, after `bun run build:packages` on a fresh checkout). Everything after `--app` goes to `playwright test`, so `--project`, `--grep`, `--headed`, `--debug` and file paths all work.

The runner pins `--workers=1` (the machine is shared). Give every concurrent run its own `CLAXEDO_E2E_PORT_RANGE`: the app is built for the daemon port, so a run whose daemon port is held by another process fails at start instead of talking to someone else's server. Each spec gets its own daemon on the run's daemon port, its own data directory, scripted model server and ACP script directory, and every process is stopped when the spec ends; a second stack in the same spec takes the next free port. `CLAXEDO_E2E_KEEP_DATA=1` keeps the data directory for diagnosis. When a spec fails, the daemon log is attached to the Playwright report (`e2e/report/`).

Typecheck the suite with `bun run typecheck:e2e`.

## Isolation

Nothing a spec does reaches the internet or this Mac's accounts, and every spec proves it.

- **Environment.** The daemon gets an allow-list environment: `PATH`, `TMPDIR`, `LANG`, `LC_ALL`, `LC_CTYPE`, `USER`, `LOGNAME`, `SHELL`, `TZ` and `CI` are inherited, nothing else. No provider key, no `ANTHROPIC_*`, `OPENAI_*` or `CLAUDE_*` variable and no agent session variable of the shell running the suite reaches it. `HOME` and every `XDG_*` directory sit in the spec's data directory, which also hides the login keychain from the `security` tool, and the daemon runs from that directory, so no project config in this repository applies. Git reads no system config and has a test identity.
- **Model traffic.** The stack stores an `anthropic` and an `openai` key and declares a custom provider of each id whose base URL is the scripted model server. The credential broker then sends every brokered turn there: Pi on either provider, Claude Code on `anthropic`, Codex on `openai`. Pi's model key is `{ providerId: "pi", modelId: "openai/gpt-4.1" }`.
- **Other traffic.** `PI_OFFLINE=1` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` turn off the agents' own update and telemetry calls, and the OpenCode model catalog reads a snapshot of the scripted providers (`CLAXEDO_OPENCODE_CATALOG_CACHE`) instead of models.dev.
- **The egress guard.** Each stack runs a proxy that refuses every request and records it, and the daemon's `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY` point at it (`NODE_USE_ENV_PROXY=1`, loopback excluded). `stack.egress.attempts` is the record. The `stack` fixture fails any spec that made an attempt outside `REFUSED_BACKGROUND_TARGETS`, the calls no switch reaches: the embedded OpenCode engine's model refresh and Codex's start-up calls. Those are refused too, just not counted.
- **Proof.** `00-isolation.spec.ts` sends Pi's default model through the app and chosen `openai` and `anthropic` models, Claude Code and Codex through the API; each must answer from the scripted server with no unexpected attempt, and Pi's connected providers must be exactly the scripted two. Its red run, `CLAXEDO_E2E_RED=1`, stores the keys without the custom providers, so the broker sends them to the vendors' hosts and every case fails on the refused attempts.

## Writing a flow

One spec per user flow, named `e2e/flows/NN-flow-name.spec.ts`, where `NN` is the flow number from the plan. The spec imports everything from `../harness`:

```ts
import { acpScriptToken, assistantText, expect, frameType, SCRIPTED_ACP_HARNESS, test } from "../harness"

test("03 send a turn: text and a tool card stream", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("turn")
  await stack.acp.write("turn", {
    steps: [
      { kind: "reasoning", text: "Looking at the file" },
      { kind: "tool", tool: "read", title: "Read README.md", locations: [{ path: `${workspace.directory}/README.md` }], text: "turn\n" },
      { kind: "text", text: "The README says turn." },
    ],
  })
  const session = await api.createSession(workspace.directory, { title: "Turn", harness: SCRIPTED_ACP_HARNESS })
  await app.goto(`${stack.url}/…`)
  await app.getByRole("textbox", { name: "Ask anything" }).fill(`Read the README. ${acpScriptToken("turn")}`)
  await app.keyboard.press("Enter")
  await expect(app.getByText("The README says turn.")).toBeVisible()
  expect(assistantText(await api.messages(workspace.directory, session.id))).toContain("The README says turn.")
})
```

Rules the checks enforce:

- Arrange through the API, act through the UI, assert what the user sees and one fact read back from the server.
- Select by role and accessible name, then by the frozen hook list. No CSS-class selectors.
- No sleeps and no `waitForTimeout`. Wait on a visible state, an `expect.poll`, or `stream.waitFor`.
- Every spec has a recorded red run: run it with `CLAXEDO_E2E_RED=1` (the ACP agent errors every turn, and model turns are refused at the egress guard) or script the failure explicitly (`{ kind: "error" }`, `scripted.scriptError(...)`) and paste the failing assertion into the commit message.
- Real Claude Code and Codex flows check `installedCli("claude")` / `installedCli("codex")` first and `test.skip(true, availability.reason)` when the binary is missing.

## Fixture API

`test` extends Playwright's `test` with three fixtures, all per test:

| Fixture | Type | What it is |
| --- | --- | --- |
| `stack` | `Stack` | The running stack: `app` (`"v1" \| "v2"`), `url` (the daemon, which also serves the app), `dataDir`, `daemon`, `scripted`, `egress`, `acp`, `events()`, `close()` |
| `api` | `ClaxedoApi` | An HTTP client for the daemon at `stack.url` |
| `app` | `Page` | Playwright's page, already at `stack.url/` |

### `stack.daemon`

| Member | Meaning |
| --- | --- |
| `makeWorkspace(name)` | A fresh git repository with one commit, registered with the daemon; returns `{ id, directory }` |
| `restart()` | Stops and relaunches the daemon on the same port and data directory (reload-recovery flows) |
| `log()` | Everything the daemon wrote to stdout and stderr |
| `acpScriptDir`, `dataDir`, `url`, `port` | Paths and address |

The daemon runs `packages/claxedo-server`'s self-hosted entry from the spec's data directory, in the environment described under [Isolation](#isolation), with `CLAXEDO_DATA_DIR` there and `CLAXEDO_APP_DIST_DIR` pointing at the built app. It counts as started once its health route answers and its own log says it is listening on the stack's URL. Pi is the default native harness.

### `stack.acp`

The scripted ACP agent is installed as the harness connection `scripted-acp` (`SCRIPTED_ACP_HARNESS = { id: "scripted-acp", access: "connection" }`). The daemon spawns it per workspace; each prompt looks for the last `acp-script:<name>` token in the prompt text and plays `<name>.json` from the spec's script directory. A prompt without a token gets the marker convention below or `ok`.

| Member | Meaning |
| --- | --- |
| `write(name, script)` | Writes a script; `acpScriptToken(name)` is the token to put in the prompt |
| `release(name)` | Releases a `{ kind: "hold", name }` step, so a spec can assert the "working" state and then let the turn finish |

Script steps (`AcpStep`):

| Step | Emits |
| --- | --- |
| `{ kind: "text", text, chunks? }` | `agent_message_chunk` text, optionally split into `chunks` deltas |
| `{ kind: "reasoning", text }` | `agent_thought_chunk` |
| `{ kind: "image", data, mimeType }` | an image content block |
| `{ kind: "plan", entries }` | a `plan` update (todo list) |
| `{ kind: "tool", tool, title, input?, text?, content?, locations?, status?, output? }` | `tool_call` then `tool_call_update`; `tool` is an ACP `ToolKind` (`read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `other`) |
| `{ kind: "diff", path, oldText, newText }` | an `edit` tool call whose content is a diff |
| `{ kind: "permission", tool, title, path?, input?, text? }` | a pending tool call plus `session/request_permission`; allowed → completed, rejected → failed, cancelled → the turn stops |
| `{ kind: "question", message, options? }` | `elicitation/create` (a question); the answer is echoed as text |
| `{ kind: "subagent", name, task, steps }` | `subagent_spawned`, the inner steps under the child session, then `subagent_state_update: completed` |
| `{ kind: "hold", name }` | Waits until `stack.acp.release(name)` |
| `{ kind: "error", message }` | Fails the prompt with a JSON-RPC error (a turn error) |
| `{ kind: "stop", reason }` | Ends the turn with that `StopReason` |

### `stack.scripted`

The scripted model server the real Claude Code, Codex and Pi processes call. A prompt containing `Reply with exactly this one token …: MARKER` returns `MARKER`; title turns return `Session MARKER`; everything else returns `ok`. `scriptTool(call)` arms one tool call, `scriptText({ marker, text })` one reply, `scriptError({ marker, status, message })` an HTTP error (429, 401, …), `holdTextReplies(marker)` a gate, `setTextStreamPacing({ chunks, delayMs })` streaming, and `requests` / `counts()` are the read-back surface.

### `stack.events(directory, { sessionId?, lastEventId? })`

Opens the stream the app reads (`/api/wr/events`) and records every frame. `frames` is the recording; `waitFor(match, { label, timeoutMs })` resolves on the first matching frame; `frameType(frame)` and `frameSessionId(frame)` read the payload. Streams close with the stack.

### `api` (`ClaxedoApi`)

`resolveWorkspace`, `setHarness`, `createSession` (optional `model`), `session`, `sessions`, `deleteSession`, `prompt` (waits for the turn; optional `model`), `promptAsync`, `abort`, `messages`, `status`, `permissions`, `replyPermission`, `questions`, `replyQuestion`, `rejectQuestion`, `providerCatalog(nativeHarness)`, `health`. Every call takes the workspace `directory` first, because that is how today's routes are scoped. A non-2xx answer throws `ApiError` with the status and body. `assistantText(messages)` joins the assistant text parts.

### Real CLIs

`installedCli("claude" | "codex")` returns `{ available: true, path, version }` or `{ available: false, reason }`. Override the binary with `CLAXEDO_E2E_CLAUDE_BIN` / `CLAXEDO_E2E_CODEX_BIN`. Native sessions use `harness: { id: "claude", access: "native" }` or `{ id: "codex", access: "native" }`.

## Layout

```
e2e/
  run.ts                 the launcher: --app=v1|v2, then playwright test
  flows/NN-name.spec.ts  one spec per flow
  harness/
    index.ts             the public surface (import from "../harness")
    fixtures.ts          test.extend: stack, api, app; fails a spec on unexpected egress
    global-setup.ts      prepareHarness: the launch gate child, the daemon port, the app build
    stack.ts             starts the egress guard, the model server and the daemon, owns ports and the data dir
    daemon.ts            the real self-hosted daemon with the built app and scripted agents
    isolated-env.ts      the daemon's allow-list environment
    egress-guard.ts      the refusing proxy and REFUSED_BACKGROUND_TARGETS
    scripted-providers.ts  routes anthropic and openai to the scripted model server
    model-catalog.ts     the OpenCode catalog snapshot
    launch-gate-child.ts builds the runtime's launch gate child
    api.ts               ClaxedoApi
    stream.ts            the /api/wr/events reader
    app.ts               --app selection and the dist-e2e build
    scripted-model-*.ts  the scripted model endpoint (chat, messages, responses dialects)
    installed-cli.ts     Claude / Codex CLI detection
    acp/                 the scripted ACP agent: script.ts (types), turn.ts (steps), agent.ts (the process)
    ports.ts, process.ts, health.ts
  probes/                one-off probes (P0.7 harness status), not collected as flows
```
