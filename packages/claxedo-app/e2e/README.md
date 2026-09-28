# End-to-end tests

The suite runs the real app against the real daemon and runtime. The only fakes sit at external boundaries: a scripted model endpoint (what the real Claude Code, Codex and Pi processes call instead of api.anthropic.com / api.openai.com) and a scripted ACP agent (a small process speaking ACP over stdio). Nothing in production code knows it is under test.

## Running

```sh
bun run e2e                                  # every flow, both projects (web + phone)
bun run e2e -- --project=phone               # 390×844, touch
bun run e2e -- --project=desktop             # the Electron app, specs tagged @desktop
bun run e2e -- e2e/flows/00-harness-smoke.spec.ts
CLAXEDO_E2E_RED=1 bun run e2e                # red run: the ACP agent fails every turn, model keys stay on the vendors' hosts
```

The launcher runs Playwright under `node --conditions=development`, and Playwright forks its workers with the same flag, so the flows and the harness load workspace packages such as `@claxedo/helpers` from source, as the app build and the daemon do, and a fresh install needs no build before Playwright loads them.

Global setup builds the workspace dists it and the daemon import when they are missing (`@claxedo/helpers`, `@claxedo/agent-runtime-contract` and `packages/process-ownership`'s launch gate child) and installs the Pi that `packages/harness/e2e/harness/pinned-pi.ts` pins, reserves the daemon port for the run (the first free port in `CLAXEDO_E2E_PORT_RANGE`, default 46100–46199, or `CLAXEDO_E2E_DAEMON_PORT`), then builds the app into `dist-e2e/` with `VITE_CLAXEDO_SERVER_URL` set to that daemon, the way a deployed bundle knows its server. The build is reused until a source file is newer than the stamp or the port changes. Every argument goes to `playwright test`, so `--project`, `--grep`, `--headed`, `--debug` and file paths all work.

The runner pins `--workers=1` (the machine is shared). Run one suite at a time per worktree: every run builds the app into the same `dist-e2e/` for its own daemon port. Give every concurrent run on the machine its own `CLAXEDO_E2E_PORT_RANGE`: the app is built for the daemon port, so a run whose daemon port is held by another process fails at start instead of talking to someone else's server. Each spec gets its own daemon on the run's daemon port, its own data directory, scripted model server and ACP script directory, and every process is stopped when the spec ends; a second stack in the same spec takes the next free port. `CLAXEDO_E2E_KEEP_DATA=1` keeps the data directory for diagnosis. When a spec fails, the daemon log is attached to the Playwright report (`e2e/report/`).

Typecheck the suite with `bun run typecheck:e2e`.

## Isolation

Nothing a spec does reaches the internet or this Mac's accounts, and every spec proves it.

- **Environment.** The daemon gets an allow-list environment: `PATH`, `TMPDIR`, `LANG`, `LC_ALL`, `LC_CTYPE`, `USER`, `LOGNAME`, `SHELL`, `TZ` and `CI` are inherited, nothing else. No provider key, no `ANTHROPIC_*`, `OPENAI_*` or `CLAUDE_*` variable and no agent session variable of the shell running the suite reaches it. `HOME` and every `XDG_*` directory sit in the spec's data directory, which also hides the login keychain from the `security` tool, and the daemon runs from that directory, so no project config in this repository applies. Git reads no system config and has a test identity.
- **Model traffic.** The stack stores an `anthropic` and an `openai` key and declares a custom provider of each id whose base URL is the scripted model server. The credential broker then sends every brokered turn there: Pi on either provider, Claude Code on `anthropic`, Codex on `openai`. Pi's model key is `{ providerId: "pi", modelId: "openai/gpt-4.1" }`.
- **Other traffic.** `PI_OFFLINE=1` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` turn off the agents' own update and telemetry calls. The OpenCode model catalog reads a snapshot of the scripted providers (`CLAXEDO_OPENCODE_CATALOG_CACHE`) instead of models.dev. Usage cost reads token-tracker's own bundled price list, seeded fresh into the stack's `~/.tokentracker/cache/pricing.json`, instead of fetching LiteLLM's from GitHub.
- **Agent CLIs.** Pi is the runtime's pinned version (`PI_EXECUTABLE`), installed by global setup. `packages/harness/e2e/harness/stand-ins/` and this suite's `harness/stand-ins/` sit first on the daemon's `PATH`: the former's `cursor-agent` answers the machine-logins probe with a signed-out status, so no real Cursor CLI runs and every machine reports the same.
- **The egress guard.** Each stack runs a proxy that refuses every request and records it, and the daemon's `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY` point at it (`NODE_USE_ENV_PROXY=1`, loopback excluded). `stack.egress.attempts` is the record. The `stack` fixture fails any spec that made an attempt outside `REFUSED_BACKGROUND_TARGETS`, the calls no switch reaches: the embedded OpenCode engine's model refresh and Codex's start-up calls. Those are refused too, just not counted.
- **Proof.** `00-isolation.spec.ts` sends Pi's default model through the app and chosen `openai` and `anthropic` models, Claude Code and Codex through the API; each must answer from the scripted server with no unexpected attempt, and Pi's connected providers must be exactly the scripted two. Its red run, `CLAXEDO_E2E_RED=1`, stores the keys without the custom providers, so the broker sends them to the vendors' hosts and every case fails on the refused attempts.

## Performance: a streaming turn

```sh
CLAXEDO_E2E_PORT_RANGE=48200-48279 bun run e2e:perf-stream -- --variants=base:/tmp/base-dist,app --runs=2 --throttle=4 --heap --out=/tmp/stream-perf
```

One isolated stack serves each variant from its own origin on a fixed port (48280 plus its position, or `name:distDir:port`), built from source unless a dist is given, so two builds of the app compare side by side. It seeds one session of 22 scripted turns per run, then streams one reply into it: a 12k-character report with headings, lists, five code fences, a table and a Mermaid diagram, with a shell call, a diff, a read and a search between its text parts, sent 8 characters every 25 ms through the scripted agent's `delayMs`. `--long` streams one 25k-character text part instead. Runs alternate the variants' order. Each run records, in a fresh Chromium context at 1440×900 and device scale 2:

- per delta, the time from the chunk reaching the page to the end of the frame that painted it (`e2e/perf/probe.js` taps the event stream and a mutation observer);
- frame intervals, long animation frames with their scripts, and the distance from the end of the timeline while it follows;
- main-thread, script, style and layout time from `Performance.getMetrics`, a CPU profile, and the heap and DOM node count after a forced collection; `--heap` adds a sampling heap profile of what survives, `--trace` a timeline trace.

`--throttle=4` slows the CPU fourfold. Each run writes `<label>-<variant>-run<N>.json`, `.cpuprofile` and, when asked, `.heapprofile` and `.trace.json` to `--out`; the builds' hidden source maps map them back to source.

## Writing a flow

One spec per user flow, named `e2e/flows/NN-flow-name.spec.ts`, where `NN` is the flow number from the plan. The spec imports everything from `../harness`:

```ts
import { acpScriptToken, assistantText, expect, SCRIPTED_ACP_HARNESS, sendPrompt, sessionRoute, test } from "../harness"

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
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await sendPrompt(app, `Read the README. ${acpScriptToken("turn")}`)
  await expect(app.getByText("The README says turn.")).toBeVisible()
  expect(assistantText(await api.messages(workspace.directory, session.id))).toContain("The README says turn.")
})
```

Rules the checks enforce:

- Arrange through the API, act through the UI, assert what the user sees and one fact read back from the server.
- One path: the accessible names and routes in `harness/ui-names.ts` (`UI`, `sessionRoute`) and the composer helper (`sendPrompt`). A flow may branch on the viewport where the app differs by size.
- Select by role and accessible name, then by the frozen hook list. No CSS-class selectors.
- No sleeps and no `waitForTimeout`. Wait on a visible state, an `expect.poll`, or `stream.waitFor`.
- A flow that reports a frame or clock number (a painted-frame recording, a task duration) runs untraced: its own spec file with `test.use(UNTRACED)` from the harness. Playwright sets trace and video per worker, so only a file or the config can turn them off. With tracing kept for failures and video on, Playwright's snapshotter adds about 4 ms of main-thread work around each action; flow 12's reveal times ran 3–9 ms lower untraced. Functional flows keep tracing.
- Every spec has a recorded red run: run it with `CLAXEDO_E2E_RED=1` (the ACP agent errors every turn, and model turns are refused at the egress guard) or script the failure explicitly (`{ kind: "error" }`, `scripted.scriptError(...)`) and paste the failing assertion into the commit message.
- Real Claude Code and Codex flows check `installedCli("claude")` / `installedCli("codex")` first and `test.skip(true, availability.reason)` when the binary is missing.

## Fixture API

`test` extends Playwright's `test` with these fixtures, all per test:

| Fixture | Type | What it is |
| --- | --- | --- |
| `stack` | `Stack` | The running stack: `url` (the daemon, which also serves the app), `dataDir`, `daemon`, `scripted`, `egress`, `acp`, `events()`, `close()` |
| `api` | `ClaxedoApi` | An HTTP client for the daemon at `stack.url` |
| `app` | `Page` | Playwright's page, already at `stack.url/` |
| `signed` | `SignedStack` | A stack signed through its own issuer, behind HTTPS (below); a signed flow uses it with Playwright's `page` instead of `stack` |
| `signedDesktop` | `Desktop` | The Electron app whose account is `signedCloud`: main's `CLAXEDO_CORE_ORIGIN` is the stack's HTTPS front, trusted through `NODE_EXTRA_CA_CERTS` and its certificate's SPKI; the keychain is cut (below). `interceptSystemBrowser(desktop.electron)` replaces main's `shell.openExternal`, so a flow opens the authorization page in Playwright's `page` and the consent redirect reaches main's loopback callback. `signInDesktop(signed, desktop, page)` runs that sign-in as the owner and waits for the account card |

### `stack.daemon`

| Member | Meaning |
| --- | --- |
| `makeWorkspace(name, projectName?)` | A fresh git repository with one commit, registered with the daemon and recorded as a project named `projectName` (the folder's name when omitted); returns `{ id, directory, projectId }` |
| `restart({ signed? })` | Stops and relaunches the daemon on the same port and data directory (reload-recovery flows); `signed` relaunches it signed, as the `signed` fixture does |
| `log()` | Everything the daemon wrote to stdout and stderr |
| `acpScriptDir`, `dataDir`, `url`, `port` | Paths and address |

The daemon runs `packages/claxedo-server`'s self-hosted entry from the spec's data directory, in the environment described under [Isolation](#isolation), with `CLAXEDO_DATA_DIR` there and `CLAXEDO_APP_DIST_DIR` pointing at the built app. It counts as started once its health route answers and its own log says it is listening on the stack's URL. Pi is the default native harness.

### `stack.gitRemote(name)`

A bare repository with one commit (`README.md` holding `<name>-source`), served over dumb HTTP from the spec's data directory on a port from the run's range: `{ url, source, close }`. Clone it the way a user would paste a URL; it closes with the stack. `git(cwd, ...args)` and `gitFolder(root, name)` run git with a test identity and make a fresh one-commit repository.

### `stack.localPages(pages, { held?, secure? })`

A loopback web server on a port from the run's range that answers each path in `pages` (path to HTML), never answers a path in `held` (an external host that hangs, such as an image that never loads), and answers 404 for anything else: `{ url, requested, close }`. `secure` serves it over HTTPS with a self-signed certificate (the config sets `ignoreHTTPSErrors`), for content the app's policy admits only over `https:`, such as a transcript image. `requested` lists every path asked for, in order, so a spec can prove what the app loaded. It closes with the stack. Flow 27 links its pages from an agent reply, because the app opens loopback links in the workspace panel's browser tab.

### `stack.acp`

The scripted ACP agent (`packages/harness/e2e/harness/acp/`, shared with the harness flows) is installed as the harness connection `scripted-acp` (`SCRIPTED_ACP_HARNESS = { id: "scripted-acp", access: "connection" }`). This suite runs it as a core ACP agent: modes and `session/load` only, with none of the Claxedo extensions, config options, commands, fork or resume the harness flows exercise, and a turn stopped during its last step ends `cancelled`. The daemon spawns it per workspace; each prompt looks for the last `acp-script:<name>` token in the prompt text and plays `<name>.json` from the spec's script directory. A prompt without a token gets the marker convention below or `ok`.

| Member | Meaning |
| --- | --- |
| `write(name, script)` | Writes a script; `acpScriptToken(name)` is the token to put in the prompt |
| `release(name)` | Releases a `{ kind: "hold", name }` step, so a spec can assert the "working" state and then let the turn finish |

Script steps (`AcpStep`):

| Step | Emits |
| --- | --- |
| `{ kind: "text", text, chunks?, delayMs? }` | `agent_message_chunk` text, optionally split into `chunks` deltas sent `delayMs` apart |
| `{ kind: "reasoning", text }` | `agent_thought_chunk` |
| `{ kind: "image", data, mimeType }` | an image content block |
| `{ kind: "plan", entries }` | a `plan` update (todo list) |
| `{ kind: "tool", tool, title, input?, text?, content?, locations?, status?, output? }` | `tool_call` then `tool_call_update`; `tool` is an ACP `ToolKind` (`read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `other`); `status: "in_progress"` sends only the `tool_call`, so the tool stays running (follow it with a `hold`) |
| `{ kind: "diff", path, oldText, newText }` | an `edit` tool call whose content is a diff |
| `{ kind: "permission", tool, title, path?, input?, text? }` | a pending tool call plus `session/request_permission`; allowed → completed, rejected → failed, cancelled → the turn stops |
| `{ kind: "question", message, options? }` | `elicitation/create` (a question); the answer is echoed as text |
| `{ kind: "subagent", name, task, steps }` | `subagent_spawned`, the inner steps under the child session, then `subagent_state_update: completed` |
| `{ kind: "hold", name, ignoresCancel? }` | Waits until `stack.acp.release(name)`; a Stop ends the wait unless `ignoresCancel`, which plays an agent that never acknowledges a cancel |
| `{ kind: "error", message }` | Fails the prompt with a JSON-RPC error (a turn error) |
| `{ kind: "stop", reason }` | Ends the turn with that `StopReason` |

### `stack.scripted`

The scripted model server the real Claude Code, Codex and Pi processes call. A prompt containing `Reply with exactly this one token …: MARKER` returns `MARKER`; title turns return `Session MARKER`; everything else returns `ok`. `scriptTool(call)` arms one tool call, `scriptText({ marker, text })` one reply, `scriptError({ marker, status, message })` an HTTP error (429, 401, …), `holdTextReplies(marker)` a gate, `setTextStreamPacing({ chunks, delayMs })` streaming, and `requests` / `counts()` are the read-back surface.

### `stack.events(directory, { sessionId?, lastEventId? })`

Opens the stream the app reads (`/api/wr/events`) and records every frame. `frames` is the recording; `waitFor(match, { label, timeoutMs })` resolves on the first matching frame; `frameType(frame)` and `frameSessionId(frame)` read the payload. Streams close with the stack.

### `api` (`ClaxedoApi`)

`resolveWorkspace`, `setHarness`, `defaultModel(directory, nativeHarness)` (the harness's current model, for a session the app will send in), `createSession` (optional `model`), `session`, `sessions`, `deleteSession`, `prompt` (waits for the turn; optional `model`), `promptAsync` (both send an ascending message id unless given one, because the app orders a transcript by id and the runtime gives an id-less prompt a random one), `stopTurn` (the recovery route's `cancel_turn`, as the app's stop button sends it), `messages`, `status`, `permissions`, `replyPermission`, `questions`, `replyQuestion`, `rejectQuestion`, `providerCatalog(nativeHarness)`, `health`. Every call takes the workspace `directory` first, because that is how today's routes are scoped. A non-2xx answer throws `ApiError` with the status and body. `assistantText(messages)` joins the assistant text parts.

`createProject(name, directory)` records a project for another folder. A stack with no project opens the onboarding screen at `/`; `makeWorkspace` records one, so a flow that made a workspace starts on the shell.

### Accessibility

`expectWithinBaseline(page, surface)` runs axe and expects no rule outside `harness/a11y-baseline.json` for that surface (`home`, `session-page`, `settings-surface`, `command-palette`, `prompt-input-focused`). It first waits (`settled`) until no animation that ends within 5 s is running, so a fade-in is not measured half-drawn.

### `signed` (the signed self-hosted stack)

The same daemon, signed through the self-hosted server's embedded Better Auth issuer, which the app signs in to with an email and a password. The issuer serves the browser's sign-in descriptor only on an HTTPS public origin, so the stack puts an HTTPS front on a port from the run's range: a self-signed certificate made with `openssl`, forwarding requests and websockets to the daemon. The config sets `ignoreHTTPSErrors`. The app is built for that origin into `dist-e2e-signed/` once per worker.

The stack starts unsigned, so the machine-wide setup (the scripted providers, Pi by default, the scripted ACP connection) runs the way a machine is used before anyone signs in. Then it restarts signed, signs up the owner, and restarts again with the owner as the deployment operator (`CLAXEDO_OPERATOR_SUBJECTS`), the only account that may record a folder project on a signed box. A signed box also signs its session stream leases, so the stack generates an Ed25519 pair for `CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM` and `…_PUBLIC_KEY_PEM`; without it `/api/wr/events` answers 503.

| Member | Meaning |
| --- | --- |
| `url` | The HTTPS origin the browser uses |
| `stack` | The stack underneath: `daemon`, `scripted`, `egress`, `acp`, `dataDir`, … |
| `owner` | The operator's `Account` |
| `signUp(name)` | Another account (`<name>@claxedo.test`, a random password) with the scripted provider keys stored for it |
| `signIn(page, account)` | Signs in through the `/login` form and waits until the page leaves it |
| `makeWorkspace(name, projectName?)` | As `stack.daemon.makeWorkspace`, recorded by the owner (project first, then the signed resolve) |

An `Account` is `{ name, email, password, subject, api, transport }`. Its `api` sends the account's bearer token straight to the daemon, reserves each session before creating it and stamps every prompt with a message id, which a signed server requires.

### `signedCloud` (the signed stack with cloud workspaces)

The `signed` stack plus what a cloud workspace needs, all real apart from the sandbox provider:

- **The relay.** A real `@claxedo/workspace-relay` (`harness/relay.ts`, `bun src/main.ts`) on a port from the run's range, resolving targets through the daemon's `/internal/relay` with a shared resolver token, verifying the daemon's Runtime Access Tokens with its public key, and minting relay host tokens with an ephemeral key. The daemon gets `CLAXEDO_WORKSPACE_RELAY_URL`, `CLAXEDO_RELAY_JWKS_URL` (the relay's JWKS, which the sandbox's session-authority calls are verified against) and the resolver token. The relay runs with its default target cache: a stopped sandbox comes back as a new container under the same host id on a new port, and the tokens the daemon mints after the wake carry the new lease epoch, which the relay's cache is keyed by.
- **The sandbox provider, faked at the Docker CLI.** `CLAXEDO_ENABLE_DOCKER_SANDBOX=1` selects the daemon's real Docker driver, and `harness/stand-ins/docker` answers the commands it runs: `create` records the container's env and port, `start` runs the repository's `workspace-runtime` on the host with that env on a free port, `port` reports it, `stop`/`rm` end it, and `host.docker.internal` in the env is rewritten to `127.0.0.1`, which is what a container's view of the host resolves to. The container's workspace is mounted at a host path: `makeCloudWorkspace` creates it with a `remoteDirectory` in the spec's data directory. The stack ends every sandbox it started when it closes (`harness/sandboxes.ts`).
- **Arranging through the API** (`harness/cloud.ts`): `makeCloudWorkspace`, `startCloudWorkspace` (the explicit connect), `cloudTurn` (reserve, create and prompt through `/workspaces/:id/*` as the owner, then the checkpoint pull that stores the transcript in the control plane, as the app does on a turn's end), `stopCloudWorkspace` (the lifecycle stop) and `storedMessages` (the control plane's copy).
- The scripted ACP agent advertises `loadSession`, so a session continues after its sandbox restarts, as a real agent's does.

Flow 24 uses it.

### Signed stack: next steps

Flows 22, 23 and 36 are on hold (owner, 19:08); flow 21 runs through option C below. What the signed stack lacks for them, and the options:

- v1 shows its "Share session" control only for a signed session it reaches as central, through the relay (`session-header.tsx:78-90`). On this stack v1 reaches the owner's folder workspaces as local, so the control never mounts, and a second account's reads are refused with 403 `relay_actor_unverified`.
- **A: the relay in the harness.** Start `@claxedo/workspace-relay` on a lane port, set `CLAXEDO_WORKSPACE_RELAY_URL`, the resolver token and the keys, and enroll the box as a host, so its workspaces are central. All harness code; the browser still signs in through `/login`. Largest: it re-derives part of `packages/claxedo-server/src/signed-browser-relay-fixture.mjs`.
- **B: an embedded-issuer mode in that fixture.** It already runs a relay, a host tunnel and a registered host, but signs browsers in only through the test bypass v2 does not have. Less code, but it edits a server test fixture v1's signed-web specs share.
- **C: flow 21 first. Done (owner-approved, 2026-09-25).** The desktop signs in to this stack through its own sign-in (system browser, loopback callback), which the embedded issuer serves, with no relay. The keychain is cut: the desktop fixture launches Electron with `--use-mock-keychain` on macOS, so Chromium's OSCrypt, which `safeStorage` uses, keeps its key in memory instead of the login keychain, and the fixture refuses to start a signed desktop (`signedDesktop`) unless main's command line carries that switch.

So the recommendation is A.

### Keychain

Moving `HOME` hides the login keychain from the `security` tool (it answers 44), but not from Electron's `safeStorage`, which goes through the Security framework and the user's own keychain search list. What keeps it out is Chromium's `--use-mock-keychain`, which makes OSCrypt (and so `safeStorage`) keep its key in memory. Playwright's Electron loader already appends it (with `--password-store=basic`) to every app it launches; the desktop fixture passes it as well on macOS so the cut does not rest on the driver, and a signed desktop (`signedDesktop`) is refused unless `app.commandLine.hasSwitch("use-mock-keychain")` holds in main before the window loads.

### `desktop` (the Electron app)

Specs tagged `@desktop` (`test("…", { tag: "@desktop" }, async ({ desktop }) => …)`) run only in the `desktop` project; `web` and `phone` skip them. The `desktop` fixture builds `packages/claxedo-desktop` when its sources or the app's are newer than the last build (`bun run prebuild`, then `electron-vite build` with `VITE_CLAXEDO_HOSTED_ACTIVATION=true`, so sign-in is offered; about a minute, recorded as a "desktop build" annotation), then launches `out/main/index.js` through Playwright's Electron driver. The app runs isolated like a stack: `HOME`, `XDG_*`, its user data and its server data in the spec's data directory, an empty `ZDOTDIR`, the egress guard, and its own scripted model server and ACP scripts. Its embedded server listens on a port from the run's range and is prepared exactly like the daemon.

The window loads the packaged document, a `file://` page, unless the spec sets `test.use({ desktopRenderer: "http" })`: then the fixture serves `out/renderer` over http on a port from the run's range and names it to main as `ELECTRON_RENDERER_URL`, so the app runs on an http origin the way `bun run dev` loads it from Vite, and every daemon read it makes is cross-origin.

The embedded server admits only its application: Electron main stamps a capability on its own renderer's requests, and nothing else can send it. So `desktop.api` and `desktop.makeWorkspace` send through the app's window, with the app's own privileges. The fixture waits for main to publish the server (`awaitInitialization`), which is when that capability is armed.

| Member | Meaning |
| --- | --- |
| `window` | The shell window (`index.local.html`) |
| `electron` | Playwright's `ElectronApplication`, for the main process and other windows |
| `api` | `ClaxedoApi` for the embedded server, sent through `window` |
| `url`, `dataDir`, `scripted`, `egress`, `acp`, `makeWorkspace(name, projectName?)`, `log()` | As on `stack` |

Closing the desktop waits for the daemon it started (the `pid` in its data directory's `local-daemon.json`) to exit before deleting that directory: a quitting app asks the daemon to drain, and the daemon writes its compile cache as it exits, up to a second after the app has gone.

`bun run dev` in `packages/claxedo-desktop` runs the desktop in development, and `bun run package:mac` packages it.

### Real CLIs

`installedCli("claude" | "codex")` returns `{ available: true, path, version }` or `{ available: false, reason }`. Override the binary with `CLAXEDO_E2E_CLAUDE_BIN` / `CLAXEDO_E2E_CODEX_BIN`. Native sessions use `harness: { id: "claude", access: "native" }` or `{ id: "codex", access: "native" }`.

## Layout

```
e2e/
  run.ts                 the launcher: playwright test with the suite's config, under the development condition
  flows/NN-name.spec.ts  one spec per flow
  harness/
    index.ts             the public surface (import from "../harness")
    fixtures.ts          test.extend: stack, api, app; fails a spec on unexpected egress
    global-setup.ts      prepareHarness: the launch gate child, the daemon port, the app build
    stack.ts             starts the egress guard, the model server and the daemon, owns ports and the data dir
    daemon.ts            the real self-hosted daemon with the built app and scripted agents
    agent-env.ts         the agent CLIs this suite's daemon finds: its stand-ins and the pinned Pi
    launch-gate-child.ts builds the runtime's launch gate child
    desktop-build.ts     builds packages/claxedo-desktop when stale
    desktop-renderer.ts  serves the built desktop renderer over http for desktopRenderer "http"
    desktop-daemon.ts    the daemon a desktop started, and waiting for it to exit
    desktop.ts           launches the Electron app isolated, with its scripted world
    scripted-world.ts    prepares a server: anthropic and openai routed to the scripted model server, Pi by default, the scripted ACP agent
    page-transport.ts    HTTP through a page
    stand-ins/           CLIs the stack must not run for real (docker)
    ui-names.ts          the accessible names and routes every flow uses
    composer.ts          sendPrompt: type into the composer and send once it accepts
    a11y.ts              the axe sweep and a11y-baseline.json, the rules each surface may still break
    git-remote.ts        a bare repository served over dumb HTTP
    local-pages.ts       loopback HTML pages for the browser tab
    signed-stack.ts      the signed stack: HTTPS front, the owner and other accounts, sign-in
    tls-front.ts         an HTTPS origin in front of the daemon (self-signed)
    proxy.ts             request and websocket forwarding to a daemon
    api.ts               ClaxedoApi
    app.ts               the dist-e2e build
    installed-cli.ts     Claude / Codex CLI detection
    acp/agent-process.ts the scripted ACP agent's PIDs under a stack's daemon
  perf/                  bun run e2e:perf-stream: a streaming turn measured on one or more builds; first-send.ts: pointerdown to the sent message painted and to the first reply text, over fresh drafts
  probes/                one-off probes (P0.7 harness status, harness health after a killed agent), not collected as flows
```

The real-stack parts both suites use are owned by `packages/harness/e2e/harness/`, which this suite imports by relative path: the isolated environment, the egress guard, ports, processes, health, git, workspaces, the HTTP transport, the event stream, the scripted model server and providers, the model catalog, usage pricing, workspace dists, the tsx loader and the scripted ACP agent. The harness also owns `ClaxedoApi`'s message rows and `assistantText`.
