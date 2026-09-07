---
title: "feat: claxedo-mcp redesign — one MCP that controls all of Claxedo from any host, with cross-harness subagents"
status: proposed; implementation not started
type: feat
date: 2026-09-07
baseline: 8e2ad30b49
package: packages/claxedo-mcp (rewrite), packages/workspace-runtime, packages/claxedo-server, packages/claxedo-local-server, packages/claxedo-desktop
backward_compatibility: none — the current `@claxedo/mcp` tool surface, stdio binary and npm package are replaced, not aliased; `claxedo-mcp documents` moves to the `claxedo` CLI or is dropped (decision below)
related: ./2026-09-05-004-pi-native-harness-remove-central-plan.md, ./2026-09-07-001-feat-transcript-interaction-records-plan.md, ./2026-08-07-002-feat-cross-harness-subagents-plan.md
---

# feat: claxedo-mcp redesign

## Overview

`@claxedo/mcp` today is a 2,237-line stdio server that proxies ten tools
(`spawn_session`, `session_messages`, `summarize_logs`, `get_logs`, `process`,
five `browser_*` tools, plus cloud-workspace lifecycle and documents helpers) to
one `CLAXEDO_SERVER_URL`. It works as code — typecheck clean, 90 tests green,
15 tools listed over stdio — and fails every product goal it was built for:

- It cannot reach a **hosted** Claxedo. Runtime paths (`/session`, `/api/wr`,
  `/documents`) do not exist at the control-plane root; they live behind the
  relay at `/workspaces/:id/...` with a Runtime Access Token that the package
  never obtains.
- It cannot **spawn a subagent on a chosen harness**. `spawn_session` declares a
  `harness` enum of `["pi"]` that the handler never reads, and it only works
  where the central runtime is mounted — which plan 004 deletes.
- It cannot tell a user **what needs them**. There is no tool over
  `GET /permission`, `GET /question`, or `GET /session/status`, and no way to
  answer a permission from another host.
- Its defaults point at the wrong server (port 3001; the desktop listens on
  2593), its version string is hardcoded `"1.0.0"` against a `0.5.0` package,
  `process stop` reports success on `false`, and its contract test asserts on
  source text rather than behaviour.

The product goal, in the user's words: *connect claxedo-mcp over any harness
app, get to know the status of any agent running and respond; from inside
Claxedo, do every backend operation supported.* The mobile half was first
imagined as an MCP App; that was dropped the same day in favour of a thin
Expo app (plan 004), because only a native app can push a notification and
take an answer from it. The MCP renders nothing.

This plan replaces the package with **one MCP server, one URL per deployment, one client**,
whose tools are derived from the runtime's machine-checked route inventory, and
which becomes the single channel through which every harness — Claude, Codex, Cursor, ACP agents,
OpenCode, Pi — can spawn a Claxedo child session on any harness.

This task produces a plan. Implementation has not started.

## Problem Frame

### Where the session write surface actually lives

Every session mutation is a workspace-runtime route in
[`session-core.ts`](../../packages/workspace-runtime/src/routes/session-core.ts):
`POST /session` (harness chosen by `?nativeHarness=claude|codex|cursor|pi|opencode`
or `?connectionId=`; bare `harness`/`runner` body fields are rejected 400),
`POST /session/:id/prompt_async`, `POST /session/:id/abort`,
`POST /session/:sessionId/permissions/:permId` (`{ response: "once" | "always" | other }`),
`POST /question/:id/reply` (`{ answers: string[][] }`), `/reject`,
`GET /permission`, `GET /question`, `GET /session/status`, `GET /event` (SSE),
`PATCH /session/:id/config` (harness switch → `switchSessionHarness` → the
handoff transaction). The inventory is
[`SESSION_CORE_ROUTE_ACCESS`](../../packages/workspace-runtime/src/session-access-policy.ts#L225)
(44 routes) with its `WRITE_OPERATIONS` set at line 270, pinned by
`session-route-inventory.guard.test.ts`. **The tool surface must be derived from
this inventory**, so a new route or a changed operation class fails a test in
the MCP package instead of silently going unreachable.

### Three deployments, one client, two hops

The MCP is scoped to the **whole control plane**: one account credential, every
workspace and machine the account can see. Inside that scope there are two
hops, because the control plane does not run agents:

1. **Control plane (account-wide).** Account, organizations, workspace list,
   and the cross-workspace session inventory (`GET /api/control/sessions`,
   [`hosted-core-app.ts:456`](../../packages/claxedo-server/src/deployments/hosted-shared/hosted-core-app.ts#L456)).
   One credential authenticates everything. "List my workspaces", "every
   session with status", "what needs me anywhere" are one call here.
2. **One workspace's runtime (per workspace).** Sessions execute in the
   workspace's sandbox or on the user's machine. Any runtime operation — send,
   abort, permission reply, messages — resolves the session's workspace, calls
   `GET /api/workspace/:id/connection`
   ([`routes/hosted/workspace.ts:598`](../../packages/claxedo-server/src/routes/hosted/workspace.ts#L598))
   once with the account credential, caches the relay URL and the
   workspace-scoped Runtime Access Token until expiry, and routes through the
   relay under `/workspaces/:id/...`. The relay deletes `Authorization` and
   stamps `x-workspace-id`
   ([`workspace-relay/src/server.ts:481`](../../packages/workspace-relay/src/server.ts#L481)),
   so the runtime never sees the account token.

| Deployment | Hop 1 | Hop 2 | Credential |
|---|---|---|---|
| Local desktop / local server | the local server itself | loopback, `/api/wr/*` unauthenticated | none (loopback trust; `CLAXEDO_AUTH_TOKEN` is ignored) |
| Hosted control plane (Cloudflare Worker) | Worker | relay, per-workspace handshake above | Claxedo-native CLI JWT (device code), stored by the CLI at `~/.claxedo/credentials.json` with a refresh token |
| Self-hosted node | the node | runtime + `DocumentsRoutes` mounted in-process | same as hosted |

The app already has a Node-safe client that speaks this contract:
[`createClaxedoServerClient`](../../packages/claxedo-app/src/platform/api/server-client-contract.ts#L161)
has zero `window`/`document`/`localStorage` references. It moves to a shared
package and the MCP reuses it plus the hosted connection handshake. One client,
three deployments, every tool.

### Hosts: text everywhere, elicitation on terminals, no MCP App

The phone and chat-host UI is the Expo app (plan 004), not an MCP App. The
MCP therefore renders nothing: every tool returns complete text `content`, so
the model and every host see the same thing. On terminal hosts a pending
permission is answered through elicitation, which Claude Code (≥ 2.1.76, form
and URL; it auto-backgrounds a tool call at 2 min unless an elicitation dialog
is open) and Codex CLI (≥ 0.119, empty schema → message-only approval;
`tool_timeout_sec` default 60) both support. Sampling and logging are
deprecated in MCP 2026-07-28 and are not used.

### Why a cross-harness subagent does not exist today

Handoff crosses harness boundaries; subagents do not. `PATCH /session/:id/config`
with a new harness runs
[`executeHandoffTransaction`](../../packages/agent-sdk-runtime/src/runtime/handoff-transaction.ts):
`renderSessionHandoff` renders the prior conversation (≤ 60,000 chars), stores
it as `config.handoff`, injects it as the next turn's system prompt, then clears
it; same session id, adapter swapped; refused while the session is busy
([runtime.ts:506](../../packages/agent-sdk-runtime/src/runtime.ts#L506)).

Subagents come in two kinds and neither picks a harness:

- **Harness-native children** (Claude `Agent`, Codex threads, Cursor tasks). The
  host only observes them: `425358fab3` taught each adapter to emit normalized
  `subagent-updated` observations keyed by a host-minted `subagentKey`, and
  `GET /session/:id/subagents` lists them. No Claxedo session is created.
- **Host-created children**: OpenCode through its engine, and the Pi `subagent`
  tool in `claxedo-server/src/session/runtime.ts:1266` → `createDispatchedSession`
  → always a Pi child. Plan 004 deletes this whole central runtime.

Tool injection channels that exist: OpenCode registers real tools through its
SDK; Claude, Cursor, Codex and ACP receive `mcpServers` from the workspace config
snapshot at launch (claude driver :390, cursor :199/:232/:284, codex
`currentMcp` :178, acp process :502); `registerSessionTools` projects a
`<claxedo_scoped_session_tools>` prompt block with a callback URL
([workspace/runtime.ts:616](../../packages/workspace-runtime/src/workspace/runtime.ts#L616))
that nothing on this branch produces. **One MCP server injected into every
harness config is the single channel that covers all harnesses**, which is why
the spawn tool belongs here. `origin/dev` had that injection
(`packages/agent-extensions/src/materialize.ts`, `CLAXEDO_MCP_AUTH_ENV`); it was
deleted locally in `b7ef49353d` and the prebuilt desktop bundle still carries it.

### Decisions already taken (2026-09-07)

- **The desktop browser-bridge token is not injected into Claxedo terminals.**
  The pty env filter strips `CLAXEDO_DESKTOP_TOKEN` on purpose and
  `pty/env.secrets.test.ts` pins that. Users install claxedo-mcp in their
  harness like any other MCP.
- **No second login for the same user.** See *Credentials* below.
- **The old package's defects are not fixed in place**; this rewrite supersedes
  them (listed under *Removed*).
- **The two harness defects the review surfaced are fixed** on this branch
  (`29f4044518` Cursor/Claude capability truth; `9db3689de0` ACP abort cancels
  pending permissions). The attention tools below read capabilities and
  pending lists that are now truthful.

## Requirements (reworked 2026-09-07)

| # | Requirement | Where it executes |
|---|---|---|
| R1 | Start a session in the current workspace, in a **new worktree**, or on a **new cloud VM**, choosing the harness | worktree and local session: the local runtime (`POST /experimental/worktree` then `POST /session`); cloud VM: the control plane creates the workspace with a sandbox lease, then the session through the relay |
| R2 | Start a **subsession** (hidden child on any harness) from inside a session | the local runtime of the parent |
| R3 | One session can **read another session's transcript**, on this machine or another | same workspace: the runtime; a cloud workspace: the control plane's checkpointed copy; a **user-hosted machine: live through the relay while that machine is online** — the control plane deliberately never mirrors user-hosted sessions |
| R4 | See what needs the user and answer it, across everything the account can see | attention feed on the control plane; replies through the runtime |
| R5 | **Processes**: start, stop, logs, with ports assigned by the workspace | the local runtime |
| R6 | **Collaborate on docs** | the documents service — today mounted only on the self-hosted node; hosted and desktop mounts are the docs plan's gap, not this plan's |
| R7 | Inside Claxedo, every session's harness config carries the first-party MCP; the endpoint verifies the caller is a genuine Claxedo-launched harness and trusts the session id it sends | the runtime that launched the session |
| R8 | Read-only mode derives from `WRITE_OPERATIONS` | — |
| R9 | One login per user per machine; loopback needs none | — |

## Design

### Shape: one server, published as a URL

There is no stdio binary and no npm package. The MCP is a streamable-HTTP
endpoint served by whichever Claxedo process is already running, and it is
installed in a harness the way every remote MCP is installed today: by URL.

```
packages/claxedo-mcp/src/          (workspace package; never published)
  client/        resolve workspace → { baseUrl, headers, prefix }; control plane + per-workspace hop
  tools/         one module per group; each exports registerX(server, ctx)
  server.ts      createClaxedoMcpHandler(): the /api/claxedo/mcp Hono route
```

| Deployment | URL | Who serves it | Auth |
|---|---|---|---|
| Hosted | `https://<control-plane>/api/claxedo/mcp` | the Worker | MCP OAuth, or the CLI JWT as bearer |
| Local desktop / local server | `http://127.0.0.1:<port>/api/claxedo/mcp` | the local server inside the desktop process | **injected runtime credential only**; no anonymous loopback |
| Self-hosted node | `https://<node>/api/claxedo/mcp` | the node | as hosted |
| Inside a Claxedo session (local or cloud) | the loopback URL of the runtime that launched it | same server | the runtime credential injected at launch plus `?session=<id>` (R7) — the only credential the loopback mount accepts |

Install UX: **one URL for every app the user installs it in — the hosted
one**, listed like any connector (Claude directory, Cursor one-click, ChatGPT
connectors, `claude mcp add --transport http`, `codex mcp add --url`), and
written into Claude Code, Codex and Cursor configs by the desktop's existing
MCP-config routes (`agent-config/routes/mcp-routes.ts`) with one click. The
loopback URL is never something a user configures; only the runtime injects
it, into sessions it launches. Decision 2026-09-07: no anonymous loopback —
offline use and account-less use were the only reasons for it, and neither is
worth a second install path. The phone's own UI is the Expo app (plan 004).

Two things fall out of serving the endpoint from the running process:

- **No desktop token anywhere.** The MCP ships no browser tools (see *Browser*
  below) and the desktop bridge is deleted, so `CLAXEDO_DESKTOP_TOKEN` ceases
  to exist.
- **No version skew.** The tools are whatever the running Claxedo ships; there
  is no published package to fall behind, and no port default to get wrong.

Why nothing stdio: every target host (Claude Code, Codex CLI, Cursor, Claude
web/desktop/mobile, ChatGPT, VS Code) accepts a remote HTTP server; a harness
with no running Claxedo has nothing to control; and `npx` adds a Node-on-PATH
requirement and a second copy of the tool code.

`claxedo-mcp documents` is a CLI feature that only shares this package's name;
it moves to `packages/cli` as `claxedo documents …` or is dropped with the
docs-v2 owner's decision.

### Where the endpoint runs, and why there is a hosted one

There is no MCP machine. The endpoint is mounted on whichever Claxedo process
is already running, and each mount serves what is local to it and brokers the
rest through the control plane:

| The harness runs on… | Endpoint it uses | Served locally | Brokered via the control plane |
|---|---|---|---|
| a session Claxedo launched on the laptop | the local server on loopback, with its injected bearer | local sessions, subsessions, worktrees, processes, this machine's transcripts | cloud VM sessions, other machines' transcripts, the attention feed, docs — using the desktop's signed-in account |
| a cloud VM (a Claxedo cloud session) | the workspace runtime on the VM's loopback | that workspace's sessions, subsessions, worktrees, processes | everything cross-workspace, using the runtime credential exchanged at the control plane for a grant in the user's identity |
| any app the user installed it in (Claude Desktop, Cursor, Claude Code, phone, Cowork), on the same Mac or elsewhere | the hosted URL on the Worker | nothing | everything; the user's machines are reached through the relay, including the Mac the app is sitting on |

The loopback mounts exist for the first two rows only and accept only the
injected runtime credential. Every app a person installs Claxedo MCP in uses the
hosted URL, even on the same Mac as the desktop; its local calls take the
Worker → relay → Mac path the web app already takes. That costs a round trip
per person-driven tool call and buys one install URL, one consent, and no
account-brokering logic in the local server.

**One route module, three mounts.** "Local" means local to wherever the
harness is, and a Claxedo process is always there: on the Mac it is the
desktop's local server, which embeds the workspace runtime; in a cloud
workspace it is the same `@claxedo/workspace-runtime` package running in the
sandbox VM, already an HTTP server, already holding the outbound relay
connection the web app reaches it through.

```
Your Mac                              Cloud VM
┌───────────────────────────┐         ┌───────────────────────────┐
│ desktop app               │         │ workspace runtime         │
│  └ local server           │         │  └ HTTP server            │
│     └ workspace runtime   │         │     └ /api/claxedo/mcp    │
│     └ /api/claxedo/mcp    │         │                           │
│ harness ──► 127.0.0.1 ────┘         │ harness ──► 127.0.0.1 ────┘
└──────────┬────────────────┘         └──────────┬────────────────┘
           │ relay connection (outbound)          │ relay connection (outbound)
           ▼                                      ▼
        ┌──────────────────────────────────────────────┐
        │ control plane (Worker) + relay               │
        │  /api/claxedo/mcp  ← phones, other machines  │
        └──────────────────────────────────────────────┘
```

**Why not the hosted address for the injected sessions too.** For the
sessions Claxedo itself launches, the loopback mount stays: a harness inside a
cloud VM would otherwise reach its own workspace by VM → Worker → relay → the
same VM on every tool call, and a laptop session would need internet to start
a dev server. The runtime is already an HTTP server, so the mount is free. For
everything a person installs, the hosted address is the only one.

Auth by situation: a session Claxedo launched, on the laptop or in a cloud
VM, never authenticates — its injected bearer is exchanged for a grant in the
user's identity when it needs the control plane; every app a person installs
Claxedo MCP in goes through MCP OAuth, which is **one consent tap in a browser that
is already signed in to Claxedo** — the control plane's authorization page
recognizes the existing web session and asks only "allow Claude to act as
you?"; a password is typed only by someone whose browser has never opened
Claxedo, once. A machine with `~/.claxedo/credentials.json` skips even the
tap. One login per user, never per harness, machine or session.

**What the control plane actually holds** (verified 2026-09-07). The relay
never dials a machine: the Mac's runtime opens an outbound tunnel to the relay
([`workspace-relay-host-tunnel.ts`](../../packages/workspace-runtime/src/workspace-relay-host-tunnel.ts))
and the relay splices requests into it, so a user-hosted workspace is
reachable exactly while the desktop is running and enrolled. The control
plane's copy of session messages is filled by **pull**: the web client, after
turn events, calls `register`/`checkpoint`/`repair`
([`routes/hosted/control.ts:112`](../../packages/claxedo-server/src/routes/hosted/control.ts#L112)),
and the control plane fetches from the runtime through the relay and stores
the result. That projection is gated to **cloud workspaces only** —
[`session-projection.ts:6`](../../packages/claxedo-app/src/platform/runtime/agent/session-projection.ts#L6)
returns no backing for a user-hosted workspace, on purpose: the machine is the
authority. Consequences for the MCP:

- cloud-session transcripts and status: control plane copy, works when the VM
  is stopped;
- user-hosted transcripts and live status: relay to the machine, online only;
- the attention feed (plan 004, S1) must therefore be fed by the runtime
  pushing attention state up, for user-hosted machines too, or it cannot
  say "your Mac session is stuck" — whether the signed inventory carries live
  status for user-hosted sessions today is **unverified** and is S1's first
  question.

**Worked trace, from inside a cloud session.** The harness in the VM knows
one server, the runtime's loopback endpoint, with the runtime credential and its session id.

- *"Start the dev server"* → `process_start`, no target given → this
  workspace → the handler calls the managed-process manager in-process. No
  network leaves the VM.
- *"Is the session on my Mac done?"* → `sessions_list` spans workspaces the
  runtime does not own → the handler exchanges the runtime credential at the
  control plane for a short-lived read grant in the user's identity (lane E;
  does not exist yet) → the control plane's inventory for the list, then, for
  a user-hosted session, the relay to the Mac for live status and transcript.
  If the Mac is offline the answer is "machine offline", not a stale copy.
- *"Reply yes to it"* → `session_send` on the Mac session → control-plane
  connection handshake for the Mac's workspace → relay
  `POST /workspaces/:id/session/:id/prompt_async` → forwarded down the
  WebSocket the Mac's runtime keeps open.

Every tool handler resolves a target the same way:

```
target is this workspace     → in-process runtime call
target elsewhere, read       → control plane, its synced copy
target elsewhere, write      → control plane handshake → relay → that runtime
```

The identical code runs on the laptop's local server for sessions the
desktop launched; only the credential differs (the desktop's signed-in
account instead of the exchanged grant). A person's own Claude Code on that
laptop is not in this picture: it uses the hosted URL.

### Client

`resolveTarget(workspaceRef)`:

- **Loopback** (local desktop, local server): base URL from `CLAXEDO_SERVER_URL`
  or the desktop default `2593`, no credential, `/api/wr` paths direct.
- **Hosted**: control-plane URL + user credential → `GET /api/workspace/:id/connection`
  → cache `{ relayUrl, runtimeAccessToken, expiresAt }`; runtime paths prefixed
  `/workspaces/:id`. Refresh on 401 or expiry.
- **Self-hosted node**: control-plane URL + credential, runtime mounted directly.

Built on `createClaxedoServerClient` after it moves out of `claxedo-app` into a
shared package (it is already Node-safe). Every tool calls the client; no tool
builds a URL.

### Credentials — one login per user

| Situation | Mechanism | Login? |
|---|---|---|
| A session Claxedo launched, on the laptop or in a cloud VM | the runtime injects the loopback URL plus its runtime credential and the session id | none |
| Claude Code / Codex on a machine where the user has signed in through the CLI or the desktop | the hosted URL, authenticated with `~/.claxedo/credentials.json` (CLI token store, with refresh); **the desktop writes the same file on sign-in** so a desktop user never runs `claxedo login` | none beyond the one the user already did |
| Any other app: Claude Desktop, Cursor, phone, Cowork — on the same Mac as the desktop or anywhere else | MCP OAuth on the hosted endpoint: the control plane's authorization page reuses the browser's existing Claxedo session and asks for consent; Claude, Cursor and Codex drive the flow themselves. The hosted control plane already runs Better Auth's OAuth server for the CLI device flow, and Better Auth ships an MCP plugin with the discovery metadata hosts expect (verify the pinned version supports it) | one consent tap, once; a password only if that browser has never seen Claxedo |

`CLAXEDO_ACCESS_TOKEN` / `CLAXEDO_DEV_TOKEN` remain overrides. The desktop's
safeStorage credential store stays for the desktop's own use; writing the shared
file is additive.

### Tool surface

Derived at build time from `SESSION_CORE_ROUTE_ACCESS`; a guard test in the MCP
package fails when a runtime operation has no tool or a tool names an operation
the inventory does not have. Read-only mode (`CLAXEDO_MCP_READ_ONLY`, already
in the pty allowlist) hides every tool whose operation is in `WRITE_OPERATIONS`.

| Group | Tools | Notes |
|---|---|---|
| Sessions | `session_create` (`harness`, `prompt`, and a placement: `{ workspace }`, `{ worktree: { name?, baseRef? } }`, or `{ cloud: { repo, machine? } }`), `sessions_list` (mine, across machines, with status), `session_get`, `session_transcript` (any session the caller may read; cloud workspaces from the control plane's copy, user-hosted machines live through the relay), `session_send`, `session_abort`, `session_handoff`, `session_rename`, `session_delete` | placement decides the executor: worktree → `POST /experimental/worktree` then `POST /session` on the local runtime; cloud → control plane creates the workspace with a sandbox lease, session created through the relay |
| Subagents | `subagent_capabilities`, `create_subagent` (`harness`, `model?`, `prompt`, `role?`, `mode: "async" \| "wait"`, `timeoutMs?`, `clientRequestId?`), `subagent_status`, `subagent_list`, `subagent_cancel` | hidden child session; the call renders as the subagent card; completion wakes the parent |
| Attention | `sessions_board` (the attention feed as text), `permission_reply`, `question_reply`, `question_reject`, `wait_for_attention` (bounded; elicitation on terminal hosts) | reads the control-plane feed plan 004 builds |
| Processes | `processes`, `process_start`, `process_stop`, `process_logs` | the workspace's managed-process manager: port templates resolved, free ports assigned, pids tracked ([`manager.ts:437`](../../packages/workspace-runtime/src/managed-processes/manager.ts#L437)); `process_stop` reports the boolean it gets |
| Documents | `documents_*` | the docs-v2 collaboration surface; available where the documents service is mounted |
| Review | `session_changes` (diff summary and checkpoints of one session) | over `GET /session/:id/diff?content=summary`; **no** raw `file_read`, `search`, `diff` or `git_status` |
| Workspaces and machines | `workspaces_list`, `workspace_status`, `workspace_lifecycle` (stop/replace/cleanup/destroy), `workspace_checkpoint` / `restore` | control plane; server enforces `approved: true` (409 otherwise) and the tool asks through host elicitation |

### Tool audiences and gating

One flat list of forty tools inside every harness duplicates native file, search
and git tools, spends context, and degrades tool selection. The credential
decides which tools `tools/list` returns:

| Credential | Audience | Tools |
|---|---|---|
| runtime credential (R7) | the model inside a Claxedo session | `session_create` (own workspace; other machines and cloud placement only with the account setting in S2), `session_transcript`, Subagents, Processes, Documents, `question_reply` for its own children only. **Never** `permission_reply`, `question_reject`, lifecycle, restore or delete (security review S1, S5). No per-session isolation otherwise (decision 2026-09-07) |
| user credential or loopback | a person on another host | Sessions, Attention, Workspaces and machines, Review, Documents |

t3code gates the same way: capabilities on the provider-session credential plus
a Claude allowlist. Read-only mode further hides `WRITE_OPERATIONS`.

### Browser: agents use an external Chrome; the in-app pane is for people

Decision (2026-09-07): **agent browser use goes through an external Chrome**,
driven by the harness's own tooling (Chrome DevTools MCP, Playwright, a
browser-use skill, Claude's or Cursor's built-in browser). Claxedo provides no
browser target, no viewer and no browser tools. On a laptop that is the user's
Chrome or a Chromium the tooling launches; in a cloud sandbox it is a Chromium
in the sandbox image that the same tooling launches next to the app under
test. Either way it is the harness's concern, not the runtime's.

The in-app browser pane is kept **only as a user surface**: side-by-side
viewing of a preview, and annotating the browser UI (the element picker
overlay that lets the user point the agent at an element). It is not an agent
target. Everything that existed to make it one goes:

- the five `browser_*` MCP tools and `desktop-request.ts`;
- the desktop HTTP bridge (`browser/http-bridge.ts`, `token.ts`,
  `CLAXEDO_DESKTOP_URL` / `CLAXEDO_DESKTOP_TOKEN`), whose only client was that
  MCP subprocess;
- the agent-facing `screenshot` / `evaluate` / `navigate` paths on
  `BrowserHandle` and the agent audit log, once nothing agent-shaped calls them.

The pane's CDP attach in `handle.ts` stays only as far as the picker overlay
and console view need it. The earlier alternatives (pane as CDP target, pane as
screencast viewer of a remote browser) are recorded in this file's history and
are not planned.

### Attention data the MCP and the mobile app share

The MCP's `sessions_board` text and the Expo app's card list (plan 004) read
the same server data: the control-plane attention feed and the additions
below. Plan 004 owns them as its lanes S0–S3 and does not depend on this
plan; whichever plan executes first builds them, the other consumes them.

- **`seen_at` per session per user.** "Finished but not seen" is not knowable
  today: the runtime has `lastTurn.completedAt` and `time.updated` but no
  watermark; the app's unseen state is client-local. Add a per-user `seen_at`
  (control plane for hosted, since it is per person; local store for the
  desktop), written when a session pane is focused in any client and when the
  mobile app opens a card. t3code added the equivalent as server visit
  watermarking for its mobile list.
- **Diff summary** already exists: `GET /session/:id/diff` with
  `content=summary` ([`routes/diff.ts:126`](../../packages/workspace-runtime/src/routes/diff.ts#L126))
  gives per-session files and line counts; `session_changes` wraps it.
- **Attention on a child reaches the parent.** When `permission.asked` or
  `question.asked` lands on a session with `parentID`, the store upserts the
  parent's subagent record with an attention count and emits
  `subagent-updated`; the parent card shows the badge, and the reply goes to
  the child's own permission id through the existing route. `GET /permission`
  already lists children because it is directory-scoped.
- **Hidden sessions stay cheap.** Verified: sounds fire only for sessions that
  resolve to an open pane
  ([`agent-status-listener.ts:257`](../../packages/claxedo-app/src/app/workbench/state/agent-status-listener.ts#L257)),
  and the list reconcile only rewrites rows that already exist, so a child is
  never inserted ([`session-list.ts:457`](../../packages/claxedo-app/src/features/session/data/query/session-list.ts#L457)).
  Remaining cost is message deltas on the directory stream for a child nobody
  is watching: the stream drops message-level events for sessions with a
  `parentID` unless that child's pane has subscribed, leaving status and the
  subagent observation.

### Inside Claxedo (R7)

**Why the runtime supplies the entry instead of the user enabling it.** A
session Claxedo launches does not read the user's own harness config: the
Claude driver passes only `mcpServers` from Claxedo's settings and never sets
`settingSources`, so the Agent SDK ignores `~/.claude.json`
([`claude/driver.ts:391`](../../packages/agent-sdk-runtime/src/harnesses/claude/driver.ts#L391));
Cursor loads plugin sources only
([`cursor/driver.ts:69`](../../packages/agent-sdk-runtime/src/harnesses/cursor/driver.ts#L69)).
The user's only lever is Claxedo's MCP settings, which apply one workspace-wide
snapshot to every session. A hosted URL with the account token pasted there
would put a long-lived account credential in every session, harness and cloud
VM, the endpoint could not tell sessions apart, and a prompt-injected agent in
one session could answer another session's permission. So: the user opts in
once ("Claxedo tools" in settings); the runtime supplies the entry per session,
with a token that names the session and expires with it.

**Credential definition and lifetime.** MCP mandates nothing here; the
bearer's meaning is the server's choice. Ours: one credential per runtime
process, claims = runtime instance id, workspace id, the user the runtime
serves, expiry; rotated on runtime restart (the mint is in that runtime's
memory) and refreshed before expiry for long-lived runtimes. It is never a
user account token, so nothing account-wide sits in a harness process or a
VM. The session id is a plain URL parameter, not a claim.

### Cross-harness subagents (R4) — two kinds, one card

**Harness-native subagents are out of scope here.** When Claude calls its
`Agent` tool, Codex opens a child thread, or Cursor runs a task, the harness
spawns the child and Claxedo observes it through the adapters landed in
`425358fab3`. Whatever those rails still get wrong is the open Definition of
Done in the cross-harness plan (child-pane UX, transcript handles, reload and
crash semantics) and is fixed there, not through this MCP.

**What this plan adds is the other kind.** A Claude session is running; the user
says *"use Codex to consult on this plan."* Today nothing can do that. The flow
after this plan:

1. The Claude session calls `create_subagent({ harness: "codex", prompt, mode: "wait" })`
   on the first-party MCP the runtime injected at launch (R7). The call carries
   the runtime credential and `?session=<id>`, so the runtime knows which session is the parent.
   **No parent history is copied.** The child gets the task prompt and an
   optional role line; the model writes the consultation brief itself, the
   way it would for its own `Agent` tool. `renderSessionHandoff` stays what it
   is: the harness-switch artifact, not a subagent seed.
2. The runtime creates a **real Claxedo session** on the Codex adapter with
   `parentID` = the Claude session, mints a `subagentKey`, and admits a
   `pending` observation on the parent — the same `subagent-updated` event the
   harness-native path emits.
3. **The tool call is the card.** Every harness adapter already classifies a
   tool call named `Agent`/`Task` as a subagent call (`isTaskTool`) and binds
   its result to the child. The same classification extends to the MCP tool
   name (`mcp__claxedo__create_subagent` on Claude, the equivalent prefix on
   Codex, Cursor and ACP): the call renders as the subagent card, not as a
   generic tool row, and the tool result's `{ subagentKey, sessionId }` is
   what binds the call to the child. This is plan 002's invariant applied
   unchanged: the child session is the identity, the spawning call is the
   edge. The card is openable beside the parent on every rail because the
   child is a real session (unlike Codex ACP or Cursor ACP children, which
   have no transcript to open).
4. `mode: "wait"` polls the child until terminal or `timeoutMs` (default under
   the host's tool timeout) and returns the child's last assistant message as
   `summary`; a timeout does not cancel the child. `mode: "async"` returns the
   key immediately; `subagent_status` reads it later.
5. **Completion wakes the parent.** When a child reaches a terminal state and
   the parent is idle, the runtime injects a follow-up turn into the parent
   carrying the child's summary; if the parent is mid-turn the wake is queued
   behind it through the follow-up steer/queue path
   (2026-08-07-001). One wake per finished child. The parent never has to
   poll.
6. Status flows through the same observation channel: running → completed /
   failed / cancelled. `subagent_cancel` aborts the child session.
7. **Not a sidebar row.** The child carries `parentID`, and the sidebar
   already loads the session list with `roots: true`, which drops any row
   with a parent (`session-core.ts:1016`, `platform/sync/session-load.ts:11`).
   It lives under its parent: the card in the parent's transcript and the
   child pane beside it. A child stuck on a permission must therefore surface
   through `attention_list` (which reads the directory's pending lists, not
   the root list) and on the parent's card. Promoting a child to a top-level
   session is a `parentID` clear and is not in this plan.
8. **Why the child is a session at all.** Spawning the harness directly in
   the tool handler (`codex exec` inside claxedo-mcp) would need no runtime
   change, but the child would have no permission prompts (pending rows are
   keyed by session id), no live card, no abort or recovery, its own copy of
   harness auth and config, and would be capped by the host's tool timeout.
   A session-less child executed by the runtime would have to re-plumb
   permissions, abort, status, the event envelope, replay and the crash sweep
   for a second kind of execution — a session with the name filed off. So the
   child is a session, hidden by `parentID`, with a lifecycle cascade: archiving
   the parent cancels active children, deleting it deletes them, and no tool
   or view lists a child except under its parent.

What the runtime must add for this:

1. **A host-owned child session.** `POST /session` accepts `parentID`, mints a
   `subagentKey`, and admits a `pending` observation on the parent so the
   existing subagent card and `GET /session/:id/subagents` see it. The session
   table already has `parent_id` (`store.ts:559`); `listSubagents` becomes
   required on the workspace-runtime store.
2. **The tool.** `create_subagent` in this package, injected into every harness
   through R7. This replaces the central Pi `spawn_session` that plan 004
   removes.
3. **Adapter classification.** `isTaskTool` (claude, cursor) and the codex /
   ACP equivalents accept the first-party MCP tool name; the tool result
   carries the child binding.
4. **Completion wake.** On child terminal, the runtime enqueues a parent turn
   with the summary (idle → start now; busy → queue).
5. **Policy ceiling.** A child's permission mode can equal or narrow the
   parent's, never widen it; the runtime enforces this at create time.
6. **Parent identity at the tool.** The `?session=<id>` the runtime injected (R7). A caller
   without one may pass `parent_session_id` explicitly and is authorized by the
   runtime like any other user call.
7. **Idempotent retries.** `clientRequestId` derives the child session id, so
   a harness that retries a timed-out tool call gets the same child back.

### Comparison: t3code orchestrator V2

t3code (`pingdotgg/t3code`) is mid-rollout of "orchestration V2" — PR #2829
(open since 2026-05-27, still updating) plus a stack of siblings (#8716 delegated
user-input requests, #9103 delegated completion wakes, #5456 child-thread
attribution, #4664 timeline grouping). The design lives in
`docs/orchestration-v2/` on those branches; the MCP half is
`orchestrator-mcp-server.md`. Read against this plan:

| Concern | t3code V2 | This plan |
|---|---|---|
| Transport into the harness | One HTTP MCP endpoint at `/mcp`, server key `t3-code`, injected into Codex (`-c mcp_servers.t3-code.url` + bearer env), Claude (`mcpServers` http + `Authorization` header, `allowedTools: mcp__t3-code__*`), Cursor (`mcpServers`), ACP (`session/new mcpServers`) | Same shape: one HTTP endpoint, the loopback URL plus a runtime credential and session id injected at launch (R7) |
| Caller identity | A credential minted per provider session, scoped to environment + parent thread + provider instance + session; expires, idle-expires, revoked on release; never persisted in orchestration state | Runtime-process credential + plain session id (R7). Deliberately coarser: no isolation between a user's own sessions |
| Spawn tool | `delegate_task` → V2 `delegated_task.request` command → child thread with `lineage.relationshipToParent = "subagent"`, an `app_owned` subagent projection on the parent, and a subagent turn item | `create_subagent` → `POST /session` with `parentID` → child session + `subagent-updated` observation + the tool call classified as the card. Same identity model: app id primary, provider id a ref |
| Context into the child | **None copied.** Task prompt + optional `role`; parent history is never transferred | Same (this revision). The earlier `seed_from_parent` idea is dropped |
| Waiting | `mode: "async" \| "wait"` with `timeoutMs`; timeout never cancels; `task_status` afterwards | Same, as `create_subagent.mode` + `subagent_status` |
| Parent wake on completion | `subagent_result` context transfer + a delegated-completion wake per finished child; queued behind a live parent run, folded like a follow-up message; cancelled wakes stay pending and are re-offered by recovery (#9103) | Adopted as runtime addition 4, on top of the follow-up steer/queue plan. Recovery re-offer is in the DoD |
| Policy ceiling | Child runtime mode may equal or narrow the parent's; interaction mode may narrow `default → plan`; escalation is a typed denial | Adopted as runtime addition 5 |
| Idempotency | `clientRequestId` derives stable command, thread and message ids; retry returns the same durable work | Adopted as runtime addition 7 |
| Capabilities discovery | `orchestrator_capabilities`: inherited provider/model, parent modes, which providers can run a child and why not | Adopted as `subagent_capabilities` |
| Child questions routed to the parent agent | `t3_pending_request_list/read/respond`: the parent *agent* answers a child's structured user-input request; approvals are never exposed to it | Not in this plan. Our attention group routes questions to the *human* on any host; letting a parent agent answer its child is a later, capability-gated addition |
| Timeline presentation | Native subagents already projected; #4664 collapses one run's local subagents into one summary row that opens the Agents panel | Our subagent card per child stays; grouping is a UI decision for plan 002's open DoD |
| Provider-native vs app-owned | Both exist side by side; MCP tools only ever address app-owned children | Same: harness-native children stay harness-spawned and observed; the MCP addresses only Claxedo-owned children |
| Everything else in their MCP | `create_threads`, `t3_thread_start/list/read/send/wait/interrupt` with `auto \| queue \| steer \| restart` send modes and `createdBy/creationSource` provenance | Our Sessions group covers these through the route inventory; provenance (`author`) already travels with the turn |

The structural difference is that t3code's MCP is a command ingress into an
event-sourced orchestrator (`ThreadManagementService` → `OrchestratorV2`), while
ours is a client over the workspace-runtime HTTP surface. That is deliberate:
our runtime is already reachable over the relay from hosted, so one client
serves three deployments and a phone; t3code's endpoint is loopback-only.

### Removed

- The stdio binary, the `npx claxedo-mcp` install path, and the npm publish of
  `@claxedo/mcp`; the package becomes a private workspace package.
- All five `browser_*` tools, `desktop-request.ts`, and the desktop HTTP bridge
  with its per-launch token; agents use an external Chrome through their own
  tooling.
- Generic `file_read`, `search`, `diff`, `git_status` tools; `session_changes`
  covers the review case.
- Central `spawn_session` (plan 004 deletes its runtime; the harness enum was
  never read).
- `summarize_logs` and the throwaway session it created.
- The transcript-file fallback in `session_messages` (reads the runtime, always).
- `_meta` approval flags on lifecycle tools (host elicitation + server 409).
- Port `3001` default, hardcoded `"1.0.0"` version, `process stop` false
  success, the source-text contract test, the stale `dist/workgraph-tools.js`.

## Phases and acceptance criteria

### Phase 1 — Client and session tools

- Shared client package extracted from `claxedo-app`; hosted connection
  handshake added; `resolveTarget` covered for all three deployments.
- Session group registered; inventory guard test green.
- **Accept when** `bun test` in the package runs the tools against a real
  `claxedo-local-server` (the `server-scope.test.ts` pattern, not source-text
  assertions) and a hosted fake that requires the connection handshake, and
  `sessions_list` + `session_create(harness: "codex")` + `session_send` +
  `session_messages` round-trip on both.

### Phase 2 — Attention and elicitation

- Attention group; `wait_for_attention` with elicitation on hosts that declare
  it and plain text otherwise.
- **Accept when** a Cursor session (which now advertises `permissions: false`)
  never appears in `attention_list` as awaiting a permission; an ACP session
  whose turn was aborted (which now clears its pending rows) disappears from
  the list without a refetch; a Claude session's pending permission can be
  answered from Codex CLI through the elicitation path.

### Phase 3 — Endpoint, hosted auth, install

- `/api/claxedo/mcp` mounted in local-server, self-hosted node and the hosted
  worker; loopback unauthenticated; hosted requires the CLI JWT or MCP OAuth.
- Desktop writes `~/.claxedo/credentials.json` on sign-in.
- **Accept when** Claude on a phone connects to a staging deployment, lists
  sessions, and approves a permission; and a fresh Claude Code on the desktop
  machine reaches hosted sessions with no login prompt.

### Phase 4 — Cross-harness subagents

- Runtime: `parentID` on `POST /session`, required `listSubagents`, session-
  scoped token minting, first-party MCP injection at launch, adapter
  classification of the MCP tool name, completion wake, permission ceiling.
- **Accept when** a Claude session creates a Codex child, the parent's
  transcript shows the `create_subagent` call as the subagent card and not as
  a generic tool row (no compat-event leak, pinned by test), `mode: "wait"`
  returns the child's answer inside the host's tool timeout, the parent is
  woken with the summary when the child finishes after a timeout, a child
  cannot widen the parent's permission mode, a retried `clientRequestId`
  returns the same child, and the child cannot spawn recursively (capability
  guard).

## Definition of Done

- [ ] Every operation in `SESSION_CORE_ROUTE_ACCESS` has a tool, and the guard test that proves it lives in `packages/claxedo-mcp`. *Progress:*
- [ ] Read-only mode is computed from `WRITE_OPERATIONS`; no tool has a hand-written read-only branch. *Progress:*
- [ ] One client answers on local, hosted and self-hosted; no tool constructs a URL. *Progress:*
- [ ] The loopback mount rejects anything but an injected runtime credential; installed apps use the hosted URL with MCP OAuth consent or `~/.claxedo/credentials.json`; the desktop writes the shared credential file. *Progress:*
- [ ] `attention_list` reflects truthful capabilities and pending lists (Cursor never pending; aborted ACP turns cleared). *Progress:*
- [ ] `wait_for_attention` returns within the host's tool timeout on Codex CLI and Claude Code and raises an elicitation there. *Progress:*
- [ ] `create_subagent` creates a host-owned child on the requested harness with no parent history copied; the call renders as the subagent card on every rail; `wait` is bounded; completion wakes an idle parent and queues behind a busy one, and a cancelled wake is re-offered by recovery; the permission ceiling holds; `clientRequestId` retries are idempotent; children cannot recurse. *Progress:*
- [ ] A child session never appears in the sidebar, `sessions_list`, or any root listing; archiving the parent cancels its active children and deleting the parent deletes them. *Progress:*
- [ ] Every session Claxedo launches carries the first-party MCP entry with the runtime credential and its session id; the endpoint rejects a request without a valid credential and accepts the session id from a valid one. *Progress:*
- [ ] No `ui://` resource and no `_meta.ui` on any tool; every tool's text content is complete on Claude Code, Codex CLI and Claude desktop alike. *Progress:*
- [ ] A per-user `seen_at` per session exists on the control plane and the local store; "finished but not seen" is computed server-side and written by pane focus and by opening a card. *Progress:*
- [ ] A child's pending permission or question raises an attention badge on the parent's card and is answerable through the child's own permission id. *Progress:*
- [ ] The directory event stream carries no message-level events for a `parentID` session whose pane is not subscribed. *Progress:*
- [ ] Central `spawn_session`, `summarize_logs`, the transcript fallback, `_meta` approval flags, the stale dist file and the source-text contract test are gone. *Progress:*
- [ ] `bun run test:architecture-ratchets` green; the shared-client extraction re-measures each product closure with no headroom and names the owner. *Progress:*
- [ ] Verified through real entrypoints: the hosted URL added to Claude Code, Codex CLI, Cursor and Claude Desktop by the desktop's one-click config write, with one consent tap; the same URL from Claude mobile against staging; the injected loopback entry from a Claxedo-launched session on the laptop and in a cloud VM. *Progress:*
- [ ] No stdio binary, no npm publish of `@claxedo/mcp`, no `CLAXEDO_DESKTOP_TOKEN` read anywhere in the MCP; `claxedo-mcp documents` relocated or removed. *Progress:*
- [ ] A runtime credential cannot call `permission_reply`, `question_reject`, `workspace_lifecycle`, `workspace_restore` or `session_delete`; the handler denies, not just `tools/list`; a test proves the self-approval path in S1 is closed. *Progress:*
- [ ] Cross-machine writes from a runtime credential are denied unless the account setting is on; the lane-E grant is read-wide and write-own-workspace. *Progress:*
- [ ] OAuth consent offers `claxedo:read | act | approve | admin`; a token without `approve` cannot reply to permissions; the client list with revoke exists in account settings. *Progress:*
- [ ] Every session created through a runtime credential is capped at the caller's permission mode. *Progress:*
- [ ] The loopback mount rejects non-loopback `Origin`/`Host`, sends no CORS headers, and the credential is never accepted from the URL. *Progress:*
- [ ] Every MCP write is audited with actor, client or runtime id, and session id. *Progress:*
- [ ] `tools/list` under a runtime credential returns only the inside-session set; under a user credential only the outside-in set; a test pins both lists. *Progress:*
- [ ] No `browser_*` tool, no desktop HTTP bridge, no `CLAXEDO_DESKTOP_*` env anywhere; the in-app pane keeps viewing and annotation and nothing agent-facing. *Progress:*

## Grounding in the codebase (2026-09-07)

Three read-only audits (MCP package and mounts; runtime; control plane), every
row backed by a file:line the audit read. Verdicts: **reuse** (as is),
**extend** (existing owner grows), **build** (nothing exists), **delete**.

### A. The endpoint and its mounts

| Concern | Exists | Verdict |
|---|---|---|
| MCP SDK | `@modelcontextprotocol/sdk` 1.29.0 (`packages/claxedo-mcp/package.json:52`). `WebStandardStreamableHTTPServerTransport.handleRequest(req: Request): Promise<Response>` (`dist/esm/server/webStandardStreamableHttp.d.ts:201`), zero Node imports; its own doc example is `transport.handleRequest(c.req.raw)`. Elicitation: `server.elicitInput` (`dist/esm/server/index.d.ts:158`) | **reuse** — this transport on all three mounts; the Node `StreamableHTTPServerTransport` (imports `node:http`) is not used |
| Mount seam | `ControlPlaneRouteContribution` (`packages/claxedo-server-core/src/platform/http/route-contribution.ts:1-38`), already mounted on local-app (`local-app.ts:316`), self-hosted node (`app.ts:1232`), hosted worker (`hosted-core-app.ts:417`). Worker `fetch` → Hono app (`core-worker.cf.ts:121`). `/api/claxedo/mcp` is unused today | **reuse** the seam; **build** the contribution |
| Old package | 24 files, 3,852 lines. `process-handler.ts` (pure, DI'd, 495 test lines), `tool-policy.ts` approval half, `cloud-workspace-tools.ts`, `documents-tools.ts` registration shape, `http-error.ts`, `request-scope.ts` | **reuse** those; **delete** `browser-tools.ts`, `desktop-request.ts`, `spawn_session` (`server.ts:503-577`), `summarize_logs` (`:579-706`), `message-text.ts`, `server.contract.test.ts` (source-string pin on `spawn_session`), transcript fallback (`:448/:461`). `tool-policy.ts` read-only half reads `process.env` → **extend** to take mode as input |
| Behaviour-test pattern | `server-scope.test.ts` drives a real MCP `Client` against a fixture server; `StreamableHTTPClientTransport` already used in `packages/claxedo-server/src/agent-plugins/mcp/protocol.e2e.test.ts:7` | **reuse** the pattern with the HTTP client transport |
| Release plumbing | `scripts/release/publish-claxedo-packages.ts:64` lists `@claxedo/mcp` as a public npm package; its test pins it; `public-docs/mcp.md` and the README document stdio + env | **delete** the publish entry, **rewrite** the docs |
| Collisions to know | `GET /mcp` on the runtime is MCP *status* (`workspace/runtime.ts:1522`); `HostedMcpGatewayRoutes` (`agent-plugins/mcp/routes.ts:22`) is an *outbound* proxy to third-party MCP servers | untouched |

### B. Auth

| Concern | Exists | Verdict |
|---|---|---|
| Better Auth | 1.7.1 (patched). `oauthProvider` + `oauthDeviceAuthorization` in `better-auth-d1-foundation.ts:151-210`; consent page `${appOrigin}/oauth/consent` served by `claxedo-app/src/app/routes/oauth-consent.tsx`; scopes `openid profile email offline_access workspace:read workspace:write` (`:26-35`) | **extend**: add an MCP resource + scope to `resources`/`scopes` (`:163-170`); decide `allowDynamicClientRegistration` (`:172`, currently `false` — MCP clients that register dynamically are blocked; either enable DCR or pre-register Claude/Cursor/Codex client ids) |
| `mcp` plugin | **absent in better-auth 1.7.1** (present only in transitive 1.6.25). `@better-auth/oauth-provider` references an `mcp()` preset that is not on disk | **build** the MCP resource metadata (`/.well-known/oauth-protected-resource`) on the provider primitives; do not plan around the plugin |
| Self-hosted auth | second `betterAuth(...)` in `self-hosted-node/embedded-auth.ts:147` without the OAuth plugin block | **extend** in parallel or MCP consent does not exist on the node |
| CLI JWT verification | `signedOrError` → `routeAuth` → `controlPlaneAuthContext` (`workspace/route-support.ts:196`, `server-core/.../auth.ts:256`) | **reuse** at the top of the MCP route |
| Credential file | `~/.claxedo/credentials.json` read/write/refresh in `packages/cli/src/auth/token-store.ts:18-95` | **reuse**; desktop → file bridge **not found** → **build** |
| Runtime credential | **nothing exists.** No session- or runtime-scoped token anywhere; `CLAXEDO_AUTH_TOKEN` is only read; RAT claims have no `session_id` (`workspace-relay-protocol/src/token-verifier.ts:29-38`) | **build** a runtime-minted credential (one per runtime process; JWT shape and verifier seam from `workspace-relay/src/auth.ts:252` as template). Delivery is per harness: Claude/Cursor/ACP take `headers` on an http MCP entry; Codex needs an env var (`bearer_token_env_var`) — note `pty/env.ts` and `env.secrets.test.ts` deny token-shaped names to child processes by design, so the Codex path needs its own decision |
| Credential exchange for a cloud VM | `POST /api/runtime-authority/session-authorize` (`routes/runtime-session-authority.ts:173`, mounted hosted `:393` and node `:1132`): verifies the RHT, re-checks the parent RAT is live, resolves the human actor (`principalKind: "user"` carries the real `actor_id`), mints a 15 s lease | **extend**: add a lease audience redeemable at control-plane read routes; today the lease is verified only by that route |
| Found defects | `/device` verification URI (`better-auth-d1-foundation.ts:207`) points at a route that does not exist anywhere; `SessionListAuthorityError` is constructed with a prose sentence where `workspaceId` goes (`session/list.ts:111` vs `:20`) | fix as small separate slices |

### C. Client and route inventory

| Concern | Exists | Verdict |
|---|---|---|
| `createClaxedoServerClient` | `claxedo-app/src/platform/api/server-client-contract.ts:161-296`; imports only `@claxedo/agent-runtime-contract` (types), `@claxedo/helpers/guards`, `./claxedo-api-types` (types); no window/document/solid; fetch injectable | **reuse** verbatim; move with `claxedo-api-types.ts` into `packages/agent-runtime-contract` (already the type dependency, no new edge) |
| Hosted connection handshake | `claxedo-app/.../workspace-relay-connection.ts:43-55` builds the two URLs, but imports `@/platform/api/api` (window.location, localStorage) | **build** a small Node-safe version: two URL builders + fetch + cache |
| Session route inventory | `SESSION_CORE_ROUTE_ACCESS` 43 routes (`session-access-policy.ts:225-268`), `WRITE_OPERATIONS` 27 (`:270-297`), pinned by `session-route-inventory.guard.test.ts` and `session-core.routes.test.ts` | **reuse** as the tool source; both guard tests change with any new route |
| Non-session families | `routes/manifest.ts:3-21` lists 20 `/api/wr/*` families (worktrees, checkpoint, process, diff, file …) but carries paths only, no methods or schemas | **build** a method/schema layer for the families the tools expose |

### D. Sessions, subagents, injection (runtime)

| Concern | Exists | Verdict |
|---|---|---|
| `POST /session` | body `{id?, title?}` + config (`session-core.ts:1038`, `session-config.ts:31-53`); harness by `?nativeHarness`/`?connectionId` only (`routes/config.ts:21-40`); `body.id` reused if it exists (`:1064-1076`) | **reuse**; `clientRequestId` → deterministic session id rides on `body.id` |
| `parentID` at create | column, index, read-back and `roots` filter exist (`store.ts:559`, `:597`, `:2710`; `session-core.ts:1016`); the create path never sets it — only `bindSession({parentSessionId})` from subagent admission (`store.ts:874-884`) | **extend**: accept `parentID` on create and thread it through `session.ts:127/252` and `workspace/runtime.ts:1583/1653` |
| Subagent admission | `observeSubagent` (`sdk-runtime-adapter.ts:561-658`) already creates the child session, binds `parent_id`, inherits config, starts and finishes the child turn, and emits the card; durable tables from `425358fab3` (`store.ts:601-677`); `GET /session/:id/subagents` (`session-core.ts:1213`) | **reuse** as the single spawn seam: the MCP handler calls admission directly |
| Card rendering | `SubagentTaskCard` keyed on tool name `task` with aliases `agent|subagent|spawn_agent` (`message-part.tsx:2475-2494`, `:3117-3136`); MCP names classify as intent `mcp` **before** the task branch (`tool-display.ts:14-15`); ambient chips need no tool-call edge (`subagent-presentation.ts:127`, `message-timeline.tsx:1888`) | **extend**: alias `create_subagent` / `mcp__claxedo__create_subagent` and reorder the intent check, or emit the observation ambient |
| Attention on the observation | `SubagentObservation` (`subagent-admission.ts:10-27`) and `SubagentUpdatedEvent` (`agent-runtime-event.ts:68-82`) have no attention field | **build** (field + both stores + `SubagentView`) |
| Per-harness spawn classification | Claude `isTaskTool` (`claude/adapter.ts:138`), Cursor `isTaskTool` (`cursor/adapter.ts:132`), Codex `collabAgentToolCall` item type (`codex/adapter.ts:87-108`); **ACP rails deleted in `c8bb14606f`** — `acp/subagent.ts` and `acp/registry.ts` no longer exist, `subagents: false` is honest | not needed if the handler calls admission directly; ACP cross-harness observation is **build** if wanted |
| MCP config injection | workspace snapshot → `applyConfig` (`workspace/runtime.ts:1352-1384`); Claude accepts `{type:"http", url, headers}` (`claude/driver.ts:391`, `:619-635`), Cursor (`cursor/driver.ts:200/233/285`), ACP `session/new mcpServers` (`acp/process.ts:502`) | **reuse** for those three; the snapshot is **workspace-grained** with a change stamp (`:787`) and an ACP restart guard (`:1303`) → **build** a launch-time injection that adds `?session=<id>` per session; the credential itself is per runtime and can ride the snapshot |
| Codex / Pi / OpenCode injection | Codex launches `app-server --listen stdio://` with no `-c` and reads `CODEX_HOME` config.toml (`codex/driver.ts:144`, `app-server-process.ts:23-27`); Pi and OpenCode have no `mcp` symbol | **build** all three (Codex: managed `CODEX_HOME` config or `-c mcp_servers.*`) |
| First-party injection precedent | `origin/dev` `packages/agent-extensions/src/materialize.ts` wrote `claxedo-mcp` into shared files (`.mcp.json`, `~/.claude.json`), workspace-scoped, no bearer; the package does not exist on this branch | not reusable at this grain |
| Placement | worktree route `POST /experimental/worktree` in **claxedo-local-server** (`shell/worktree-routes.ts:44-73`, local workspaces only, body `{name?, startCommand?}`); cloud `POST /create` (`routes/hosted/workspace.ts:323`, body `:139-160`); the app orchestrates resolve → provision → bootstrap → create in `composer/ui/submit.ts:241-296` | **reuse** both routes; **build** a server-side placement primitive, since none exists |
| Completion wake | no queue or steer anywhere; a second prompt is refused ("Session is already processing a message", `sdk-runtime-adapter.ts:425`, `acp/turn-runner.ts:275`); plan 2026-08-07-001 is unimplemented. Child terminal is detected at `sdk-runtime-adapter.ts:649-657`; delivery is `prompt_async` (`session-core.ts:1673`) with message-id admission | **build**: hold the wake until the parent is idle, then `prompt_async`; the full steer/queue is plan 001's |
| Permission ceiling | `AutoLevel = ask|auto|full` (`adapter-contract.ts:261`), per-harness tables (`permission-modes.ts:88-189`), get/set routes; **no comparator or rank** | **extend**: total order on `AutoLevel` + a rule for unleveled modes (`plan`, `dontAsk` …); cross-harness comparison is **build** |

### E. Control plane: attention feed, seen, push (owned by plan 004 lanes S1–S4, consumed here)

| Concern | Exists | Verdict |
|---|---|---|
| Session inventory | `GET /api/control/sessions` (`hosted-core-app.ts:456` → `D1SessionAuthority.listSessions`, `session-authority.ts:970`) returns `session_id, project_id, title, created_at, updated_at` only; workspace-scoped; sibling `/api/control/session-list` refuses user-hosted (`session/list.ts:104-114`) while this one does not | **extend** into a cross-workspace feed read in the shared `session/list.ts` module, mounted twice |
| Per-session status on the CP | **none, for any workspace kind.** `sessions` table has no status column (migration `0003:35-63`); the pull already fetches `/session/status` and discards it (`hosted-session-pull.ts:309-316`); hosted `/runtime/register` and `/heartbeat` are no-ops (`control.ts:95-103`); the desktop connector heartbeat carries `workspaceIds` only, every 20 s (`host-connector/src/connector.ts:287`) | **build** a status/attention channel: persist what the pull sees for cloud; add a session-attention payload to the connector heartbeat for user-hosted |
| Pending permissions on the CP | none (zero hits in authority and hosted routes); runtime-only (`workspace-runtime/src/store.ts:733`) | **build** (carried by the channel above) |
| `seen_at` | none server-side; client `notification.tsx:47-59` is per-device localStorage with no permission type | **build** table + authority method; **extend** the client to read it |
| Diff counts | none on the CP; per-session diff summary exists on the runtime (`routes/diff.ts:126`) | **build** into the feed via the same channel |
| Push | none (no expo/apns/fcm/device-token anywhere); `notifyOwner` (`channels/control-plane.ts:609-670`) already does recipient resolution, gating, idempotent claims and daily ceilings for chat channels | **build** token registration + Expo transport as a new transport kind in `claxedo-channels/src/registry.ts:3`; **reuse** `notifyOwner` |
| Self-hosted parity | every hosted route has a node twin with a different producer (`self-hosted-node/app.ts:1132-1143`); the node's session routes have a loopback branch with no user identity (`control-plane-session.ts:246-262`) | every addition mounts twice; per-user `seen_at` is undefined on the loopback branch and must say so |

### What this changes in the plan above

- **ACP is not a cross-harness subagent rail today.** The rails from `425358fab3` were removed in `c8bb14606f`; the comparison table and the D3 docs note that cite `acp/subagent.ts` are corrected below.
- **Codex has no MCP injection at all**, so "injected into every harness" is Claude, Cursor and ACP today and Codex, Pi, OpenCode are new work.
- **The runtime credential is entirely new**, including how Codex receives it given the pty secret filter.
- **Placement and completion wake have no server-side primitive**; both are builds, and the wake is the minimal "deliver on idle" form, not plan 001.
- **The attention feed has no data source yet for user-hosted machines**; the connector heartbeat is the channel to extend, which plan 004 lane S1 now owns explicitly.

## Security review (2026-09-07)

Reviewed against the plan as written above, from the point of view of the
three untrusted parties it admits: **the model** inside any session (prompt
injection is the baseline threat, not an edge case), **a process on the same
machine** as a loopback mount, and **an MCP client app** the user consented
to. The assets: the account; every session on every machine, since "send a
prompt" is code execution by an agent; permission approvals; process control;
transcripts, which carry whatever the user pasted; cloud workspace lifecycle,
which is money.

### Findings, ranked

**S1 — Critical: in-session `permission_reply` is a self-approval loophole.**
The runtime-credential audience includes `permission_reply`. A prompt-injected
agent creates a child (`create_subagent`), tells it to run `rm -rf`, the child
asks for permission, the parent approves it through the MCP. The human never
sees the prompt. The permission ceiling does not help: the child was never
widened, it was approved. *Change:* remove `permission_reply` and
`question_reject` from the runtime-credential audience entirely. Approvals are
answered by a human credential only, on any host. `question_reply` may stay for
a parent answering its own child's structured question, which is what t3code
allows ("approvals are never exposed" to the parent agent), and only for
sessions whose `parentID` is the caller.

**S2 — High: lateral movement across machines from one compromised session.**
With no isolation between a user's sessions (decision), a compromised cloud
VM or a prompt-injected laptop session can `session_send` to the user's Mac
session, `session_create` on another machine, or read every transcript. Lane
E's credential exchange makes the VM's runtime credential worth the user's
whole account. *Change:* the exchanged grant is **read account-wide, write only
to the caller's own workspace** by default. Cross-machine writes
(`session_send`, `session_create` with a placement on another machine,
`subagent_cancel` elsewhere) from a runtime credential require a per-account
setting the user turns on ("agents may act on my other machines"), off by
default. Transcript reads across machines stay allowed and are logged (S11).

**S3 — High: the OAuth token is the whole account with no scopes.** A consented
client app (or the model driving it) can do everything a user can, including
`workspace_lifecycle destroy`. *Change:* define scopes at consent —
`claxedo:read`, `claxedo:act` (send, abort, create, processes),
`claxedo:approve` (permission and question replies), `claxedo:admin`
(lifecycle, delete) — and default the consent page to read + act. Access
tokens are already 300 s with rotating 30-day refresh
(`better-auth-d1-foundation.ts:186-190`); expose the client list with revoke
(RFC 7009 already served) in account settings.

**S4 — High: escalation by creating a wider session instead of a child.** The
ceiling applies to `create_subagent` only. A prompt-injected agent in `ask`
mode calls `session_create` (not a subagent) and gets a session in the
harness's default `auto` mode, then `session_send`s it the dangerous command.
*Change:* any session created through a runtime credential inherits the
caller's permission mode as its maximum, whether or not it is linked as a
child.

**S5 — High: destructive and costly tools must not trust model-supplied
flags or auto-allow lists.** The old package took `approved` from the model's
arguments; the plan already drops `_meta` flags but must not reintroduce an
argument. Inside SDK sessions the harness's own permission prompt is the only
human check on an MCP call, and it is skipped in `auto`/`full` modes and for
anything in an `allowedTools` list. *Change:* `workspace_lifecycle`
(replace/cleanup/destroy), `workspace_restore`, `session_delete` and cloud
placement are served only to human credentials, are annotated
`destructiveHint: true` (MCP tool annotations) so hosts prompt, and on hosts
that support it are confirmed through elicitation server-side before the
runtime call; never add a Claxedo write tool to any harness auto-allow list.
Agent-initiated cloud placement additionally sits behind the S2 setting and
the existing `sandboxLeaseCap`.

**S6 — Medium: gating and read-only must be enforced in handlers, not in
`tools/list`.** A client can call a tool it was not listed. *Change:* every
handler checks the credential's audience and the read-only flag and returns a
typed denial; `tools/list` is a courtesy. Read-only becomes a property of the
credential, not of `process.env` (the old `tool-policy.ts` read env).

**S7 — Medium: loopback endpoint hardening.** MCP's own spec requires local
HTTP servers to validate `Origin` against DNS rebinding. *Change:* bind
127.0.0.1 only; reject requests whose `Origin` or `Host` is not loopback or
absent; no CORS headers on this route; the runtime credential travels only in
the `Authorization` header, never in the URL (the URL carries just
`?session=<id>`, which is not secret). Reuse `unsignedLocalRequestGuard`'s
loopback detection (`deployment-mode.ts:172`) rather than a second check.

**S8 — Medium: the runtime credential at rest.** For Claude, Cursor and ACP it
is an in-memory option or a stdio message. For Codex it lands in a file under
the managed `CODEX_HOME`, readable by any process of the same user; inside a
VM every process is the agent's. *Accept* the same-user-local exposure (that
process already owns the machine) and *mitigate:* 0600, rotate on runtime
restart, refuse a credential older than its expiry, never log it, and treat a
VM's credential as worth exactly S2's grant and no more.

**S9 — Medium: `~/.claxedo/credentials.json` is reachable from Claxedo
terminals.** `HOME` passes through the pty filter by design (`pty/env.ts:125-130`
says so), so an agent in a Claxedo terminal can read the CLI's refresh token
today. The plan makes that file worth more (it unlocks the hosted MCP) and
has the desktop write it. *Change:* do not have the desktop write a refresh
token there by default; write it only when the user enables "CLI sign-in from
the desktop", and prefer the OS keychain for the CLI store as a follow-up.
Record the accepted residual risk for CLI users.

**S10 — Medium: resource abuse.** Children creating children, unbounded
`wait_for_attention` long-polls holding Worker connections, a hosted token
hammering the relay. *Change:* no recursion (already in the DoD); caps of
four active children per parent and a per-account ceiling; `mode: "wait"` and
`wait_for_attention` bounded to 50 s and counted per credential; per-token
rate limits on the hosted mount using the existing rate-limit middleware the
workspace create route uses (`routes/hosted/workspace.ts:333`).

**S11 — Medium: audit.** Every write through the MCP must be attributable to
actor + client (OAuth client id or runtime instance) + session id.
*Change:* write to the existing `authority_audit_events` (migration 0005) on
the control plane and to the runtime journal locally; `session_transcript`
reads across machines are logged too, since S2 leaves them open.

**S12 — Low: idempotency ids.** Deriving a child session id from
`clientRequestId` must be HMAC(server secret, caller identity, request id),
not a hash of the request id alone, or another caller can collide and claim
an id (`POST /session` reuses an existing `body.id`, `session-core.ts:1064`).

**S13 — Low: consent and client registration.** Dynamic client registration is
off today (`better-auth-d1-foundation.ts:172`). If it is enabled for MCP
clients: PKCE required, redirect URIs restricted to the client's registered
set, the consent page shows the client's name and requested scopes, and
unverified clients get no `claxedo:admin`. Elicitation is a check against the
*model*, not against a malicious client: a client can auto-accept its own
elicitations, so S5's server-side confirmation is a UX guard for honest
clients, and S3's scopes are the real boundary.

**S14 — Accepted: transcript exfiltration.** A prompt-injected agent can read
the user's other transcripts and leak them wherever it can already leak files.
Accepted with S2's default (read allowed, logged) because the agent already
has the filesystem; revisit if transcripts start carrying credentials by
design.

### Plan 004 (mobile) items that follow from this review

- Push payloads carry ids and a title only, never the command text or
  question body; the app fetches content after unlock. Notification actions
  "Allow once"/"Deny" require device authentication (`authenticationRequired`
  on the iOS category; Android equivalent), never from a locked screen.
- Push tokens are bound to the user and device, revoked on sign-out and on
  account revocation; `seen_at` writes are bound to the authenticated user
  and cannot name another user.
- The attention feed exposes only sessions the caller may read
  (`actorSessionAccessSql`, `session-authority.ts:1885`), never the
  workspace's full inventory.

### Changes applied to the plan by this review

- Runtime-credential audience: `permission_reply` and `question_reject`
  removed; `question_reply` limited to the caller's own children (S1).
- Cross-machine writes from a runtime credential are off by default behind an
  account setting; the lane-E grant is read-wide, write-own-workspace (S2).
- OAuth scopes `claxedo:read | act | approve | admin` at consent (S3).
- Permission ceiling applies to every session a runtime credential creates
  (S4).
- Destructive tools: human credentials only, annotated, elicitation-confirmed,
  no model-supplied `approved` (S5).

## Verification

```bash
cd packages/claxedo-mcp && bun run typecheck && bun run test
```
```bash
cd packages/workspace-runtime && bun run typecheck && bun run test
```
```bash
bun run test:architecture-ratchets
```

Real entrypoints per phase are the acceptance lines above. Nothing in this plan
is done because a unit test is green; each phase names the host and deployment
it was exercised on.

## Execution: parallelize with agents and workflows

Disjoint ownership; each lane is one agent with its own files, verified by its
own tests before merge:

| Lane | Owns | Depends on |
|---|---|---|
| A. Client | shared client package, hosted handshake, `client/` | nothing |
| B. Session, process, review tools + gating | `tools/sessions`, `tools/processes`, `tools/review`, `tools/documents` relocation, audience gating on `tools/list`, inventory guard | A's interface (stub first) |
| C. Attention + elicitation | `tools/attention`, `wait_for_attention` | A |
| D. Endpoint + auth + install | `server.ts` route, the three mounts, OAuth on hosted, desktop one-click config write, desktop credential-file write | A |
| E. Runtime subagent support | `POST /session parentID`, token mint, injection, adapter classification of the MCP tool name, completion wake, permission ceiling | nothing (workspace-runtime only) |
| F. Subagent tools | `tools/subagents` | B, E |
| H. Browser deletions | delete `browser_*` tools, `desktop-request.ts`, the desktop HTTP bridge and its token; keep the pane as a user view/annotate surface only | nothing (desktop only) |

A and E start together. B, C, D pipeline behind A. F behind B+E.
Research and verification fan out the same way: one agent per host (Claude
Code, Codex CLI, Cursor, Claude mobile) runs the acceptance line for each phase
and reports the exact command and outcome. Review agents must not touch
uncommitted work in the shared worktree; each lane commits its slice.
