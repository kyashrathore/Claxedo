# End-to-end tests

The suite runs the real app against the real daemon and runtime. The only fakes sit at external boundaries: a scripted model endpoint (what the real Claude Code, Codex and Pi processes call instead of api.anthropic.com / api.openai.com) and a scripted ACP agent (a small process speaking ACP over stdio). Nothing in production code knows it is under test.

## Running

```sh
bun run e2e -- --app=v2                      # every flow, v2, both projects (web + phone)
bun run e2e -- --app=v1                      # the same flows against today's app (baseline flows only)
bun run e2e -- --app=v2 --project=phone      # 390×844, touch
bun run e2e -- --app=v2 --project=desktop    # the Electron app, specs tagged @desktop
bun run e2e -- --app=v2 e2e/flows/00-harness-smoke.spec.ts
CLAXEDO_E2E_RED=1 bun run e2e -- --app=v2    # red run: the ACP agent fails every turn, model keys stay on the vendors' hosts
```

`--app` picks which package the daemon serves: `v1` is `packages/claxedo-app`, `v2` is this package. Global setup builds `packages/agent-sdk-runtime`'s launch gate child when it is missing (and `@claxedo/helpers` first, which that bundle needs), reserves the daemon port for the run (the first free port in `CLAXEDO_E2E_PORT_RANGE`, default 46100–46199, or `CLAXEDO_E2E_DAEMON_PORT`), then builds the chosen app into its `dist-e2e/` with `VITE_CLAXEDO_SERVER_URL` set to that daemon, the way a deployed bundle knows its server. The build is reused until a source file is newer than the stamp or the port changes (v2 builds in about 1.5 s; v1 in about 14 s, after `bun run build:packages` on a fresh checkout). Everything after `--app` goes to `playwright test`, so `--project`, `--grep`, `--headed`, `--debug` and file paths all work.

The runner pins `--workers=1` (the machine is shared). Run one suite at a time per worktree: every run builds the app into the same `dist-e2e/` for its own daemon port. Give every concurrent run on the machine its own `CLAXEDO_E2E_PORT_RANGE`: the app is built for the daemon port, so a run whose daemon port is held by another process fails at start instead of talking to someone else's server. Each spec gets its own daemon on the run's daemon port, its own data directory, scripted model server and ACP script directory, and every process is stopped when the spec ends; a second stack in the same spec takes the next free port. `CLAXEDO_E2E_KEEP_DATA=1` keeps the data directory for diagnosis. When a spec fails, the daemon log is attached to the Playwright report (`e2e/report/`).

Typecheck the suite with `bun run typecheck:e2e`.

## Isolation

Nothing a spec does reaches the internet or this Mac's accounts, and every spec proves it.

- **Environment.** The daemon gets an allow-list environment: `PATH`, `TMPDIR`, `LANG`, `LC_ALL`, `LC_CTYPE`, `USER`, `LOGNAME`, `SHELL`, `TZ` and `CI` are inherited, nothing else. No provider key, no `ANTHROPIC_*`, `OPENAI_*` or `CLAUDE_*` variable and no agent session variable of the shell running the suite reaches it. `HOME` and every `XDG_*` directory sit in the spec's data directory, which also hides the login keychain from the `security` tool, and the daemon runs from that directory, so no project config in this repository applies. Git reads no system config and has a test identity.
- **Model traffic.** The stack stores an `anthropic` and an `openai` key and declares a custom provider of each id whose base URL is the scripted model server. The credential broker then sends every brokered turn there: Pi on either provider, Claude Code on `anthropic`, Codex on `openai`. Pi's model key is `{ providerId: "pi", modelId: "openai/gpt-4.1" }`.
- **Other traffic.** `PI_OFFLINE=1` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` turn off the agents' own update and telemetry calls. The OpenCode model catalog reads a snapshot of the scripted providers (`CLAXEDO_OPENCODE_CATALOG_CACHE`) instead of models.dev. Usage cost reads token-tracker's own bundled price list, seeded fresh into the stack's `~/.tokentracker/cache/pricing.json`, instead of fetching LiteLLM's from GitHub.
- **Agent CLIs.** Pi is the runtime's pinned version (`PI_EXECUTABLE`), installed by global setup. `harness/stand-ins/` sits first on the daemon's `PATH`: its `cursor-agent` answers the machine-logins probe with a signed-out status, so no real Cursor CLI runs and every machine reports the same.
- **The egress guard.** Each stack runs a proxy that refuses every request and records it, and the daemon's `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY` point at it (`NODE_USE_ENV_PROXY=1`, loopback excluded). `stack.egress.attempts` is the record. The `stack` fixture fails any spec that made an attempt outside `REFUSED_BACKGROUND_TARGETS`, the calls no switch reaches: the embedded OpenCode engine's model refresh and Codex's start-up calls. Those are refused too, just not counted.
- **Proof.** `00-isolation.spec.ts` sends Pi's default model through the app and chosen `openai` and `anthropic` models, Claude Code and Codex through the API; each must answer from the scripted server with no unexpected attempt, and Pi's connected providers must be exactly the scripted two. Its red run, `CLAXEDO_E2E_RED=1`, stores the keys without the custom providers, so the broker sends them to the vendors' hosts and every case fails on the refused attempts.

## Parity: v1 against v2, screen by screen

```sh
CLAXEDO_E2E_PORT_RANGE=46100-46149 bun run e2e:parity                        # every screen, both sizes (about 3 min)
CLAXEDO_E2E_PORT_RANGE=46100-46149 bun run e2e:parity -- --screens=session,palette --sizes=1280
```

One isolated stack serves both apps with the same data. Each app is built for its own port (into `e2e/parity/.builds/<app>`) and served same-origin, with every API, stream and socket request forwarded to the one daemon. Screens marked `fresh` are captured first, on the empty stack. Then the seed runs: a project "Parity" with a committed `src/app.ts` and an uncommitted README change, a session with a finished scripted turn (reasoning, read/search/shell tool cards, a diff, a todo, a reply with a code block), and a second session. The seeded screens follow.

Every capture gets a fresh browser context at 1280×800, or 390×844 with touch: light scheme, reduced motion, `en-US`, UTC, device scale 1. It is taken once two frames 250 ms apart are identical. The output lands in `e2e/parity/out/`: `<screen>-<size>-v1.png`, `-v2.png`, `-side.png` (v1, v2, and the differing pixels in red), `results.json`, and `index.html`, most different first. A pixel counts as different when a channel differs by more than 24. The percentage understates a moved layout on a white page, so read the side-by-side.

Add a screen in `e2e/parity/screens.ts`: its id (use the inventory's screen name), `fresh` or `seeded`, its sizes, its path per app, and its steps. Steps use v1's accessible names on both apps. A step that fails on v2 is reported in red: v2 lacks v1's control, which is a parity finding, not a tool bug.

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

### `stack.gitRemote(name)`

A bare repository with one commit (`README.md` holding `<name>-source`), served over dumb HTTP from the spec's data directory on a port from the run's range: `{ url, source, close }`. Clone it the way a user would paste a URL; it closes with the stack. `git(cwd, ...args)` and `gitFolder(root, name)` run git with a test identity and make a fresh one-commit repository.

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

`createProject(name, directory)` records a project for a folder. A stack with no project opens the onboarding screen at `/`, so a flow that starts on the shell creates one first.

### Accessibility

`expectNoAxeViolations(page, screen)` runs axe on the page and expects nothing; v2 flows use it. `expectWithinV1Baseline(page, surface)` expects no rule outside today's app's `packages/claxedo-app/e2e/playwright/a11y-baseline.json` for that surface (`home`, `session-page`, `settings-surface`, `command-palette`, `prompt-input-focused`); v1 paths use it, and only on those surfaces. Both first wait (`settled`) until no animation that ends within 5 s is running, so a fade-in is not measured half-drawn.

### `desktop` (the Electron app)

Specs tagged `@desktop` (`test("…", { tag: "@desktop" }, async ({ desktop }) => …)`) run only in the `desktop` project; `web` and `phone` skip them. The `desktop` fixture builds `packages/claxedo-desktop` for the chosen app when its sources or the app's are newer than the last build (`bun run prebuild`, then `electron-vite build`, with `CLAXEDO_DESKTOP_RENDERER=v2` for v2; about a minute, recorded as a "desktop build" annotation), then launches `out/main/index.js` through Playwright's Electron driver. The app runs isolated like a stack: `HOME`, `XDG_*`, its user data and its server data in the spec's data directory, an empty `ZDOTDIR`, the egress guard, and its own scripted model server and ACP scripts. Its embedded server listens on a port from the run's range and is prepared exactly like the daemon.

The embedded server admits only its application: Electron main stamps a capability on its own renderer's requests, and nothing else can send it. So `desktop.api` and `desktop.makeWorkspace` send through the app's window, with the app's own privileges. The fixture waits for main to publish the server (`awaitInitialization`), which is when that capability is armed.

| Member | Meaning |
| --- | --- |
| `window` | The shell window (`index.local.html`) |
| `electron` | Playwright's `ElectronApplication`, for the main process and other windows |
| `api` | `ClaxedoApi` for the embedded server, sent through `window` |
| `url`, `dataDir`, `scripted`, `egress`, `acp`, `makeWorkspace(name)`, `log()` | As on `stack` |

`bun run dev:v2` in `packages/claxedo-desktop` runs the desktop in development with the v2 renderer. Packaging v2 (`package:mac:v2`) waits on a v2 build without the auth vendor client, which the desktop's unsigned boundary check requires.

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
    desktop-build.ts     builds packages/claxedo-desktop for the chosen app when stale
    desktop.ts           launches the Electron app isolated, with its scripted world
    scripted-world.ts    prepares a server: scripted providers, Pi by default, the scripted ACP agent
    workspaces.ts        a fresh repository registered with a server
    transport.ts         HTTP straight to a server, or through a page
    node-loader.ts       the tsx loader for scripts that run under node
    pinned-pi.ts         the runtime's pinned Pi for every stack
    usage-pricing.ts     token-tracker's bundled price list, seeded into the stack's home
    stand-ins/           agent CLIs the stack must not run for real (cursor-agent)
  parity/                bun run e2e:parity: v1 and v2 side by side (origin, seed, screens, settle, compare, report)
    git.ts               git with a test identity; one-commit repositories
    git-remote.ts        a bare repository served over dumb HTTP
    api.ts               ClaxedoApi
    stream.ts            the /api/wr/events reader
    app.ts               --app selection and the dist-e2e build
    scripted-model-*.ts  the scripted model endpoint (chat, messages, responses dialects)
    installed-cli.ts     Claude / Codex CLI detection
    acp/                 the scripted ACP agent: script.ts (types), turn.ts (steps), agent.ts (the process)
    ports.ts, process.ts, health.ts
  probes/                one-off probes (P0.7 harness status), not collected as flows
```
