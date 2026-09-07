---
title: "feat: Claxedo mobile — an Expo app for the attention loop (cards, last turn, reply, diff) with push notifications"
status: proposed; implementation not started
type: feat
date: 2026-09-07
baseline: 8e2ad30b49
package: packages/claxedo-mobile (new), packages/claxedo-server (attention feed, seen_at, push), packages/workspace-runtime (child attention, diff summary), shared client package extracted from claxedo-app
backward_compatibility: none — new surface; no existing mobile code
related: ./2026-09-07-003-feat-claxedo-mcp-redesign-plan.md, ./2026-08-07-001-feat-followup-steer-queue-plan.md
---

# feat: Claxedo mobile (Expo)

## Overview

Plan 003 gives every MCP host a text `sessions_board`: which sessions need
the user, and tools to answer. Text is enough for a chat host. It is not a
phone: nothing can **push a notification when an agent is stuck**, nothing
lets the user **answer from the notification**, and nothing exists without
first opening a chat app. This app is that surface and nothing more: a card
list of sessions that need the user, a detail view of the last turn with a
composer and a plain diff, and push. It replaces the MCP App that an earlier
draft of plan 003 proposed; the MCP now renders nothing.

The app is a thin client of HTTP routes on the control plane and, through the
relay, on a workspace runtime. **It does not depend on the claxedo-mcp rework
(plan 003) and does not call MCP tools.** It can be built first. What it needs
from the backend, this plan builds:

- the shared client package extracted from `claxedo-app`
  (`createClaxedoServerClient` plus the hosted connection handshake) — a file
  move, listed here as lane S0 so nothing waits on plan 003;
- an **attention feed** route on the control plane: every session the user
  should look at, across workspaces and machines, with its reason;
- per-user `seen_at`, child attention propagated to the parent, and the
  per-session diff summary wrapper;
- push registration and an attention notifier.

Plan 003's `sessions_board` text tool reads the same attention feed once it
exists. Whichever plan executes first builds the shared pieces; the other
consumes them. Better Auth, which the hosted control plane already uses and
which ships an Expo client, is reused as is.

This task produces a plan. Implementation has not started.

## What the field does (survey, 2026-09-07)

Read from the repositories' mobile manifests, not from docs.

| | t3code `apps/mobile` | orca `mobile/` | superset `apps/mobile` | paseo `packages/app` | synara |
|---|---|---|---|---|---|
| Framework | Expo 57, RN 0.86, React 19 | Expo 55, RN 0.83, React 19 | Expo 57, RN 0.86, React 19 | Expo 54, RN 0.81, React 19 | **no mobile app**; responsive web served over LAN/Tailscale with a token |
| Routing | `@react-navigation/native-stack` (no expo-router) | expo-router | expo-router | expo-router + react-navigation | — |
| Styling | uniwind (Tailwind) | plain RN styles | uniwind + Tailwind 4 + `@rn-primitives/*` (shadcn-style) | react-native-unistyles | — |
| State / data | Effect + `@effect/atom-react`, own `client-runtime` Connection over WebSocket, expo-sqlite cache | zustand, `ws` | tRPC + react-query, zustand | react-query | — |
| Auth | Clerk (`@clerk/expo`) | key pairing (tweetnacl) | Better Auth (`@better-auth/expo`) + Apple sign-in | device pairing (mnemonic id) | token |
| Reaching the machine | own server over WebSocket; "server visit watermarking" for seen state | desktop hosts a WS RPC server on :6768; own relay in `cloud/` (director + cells) splices phone↔desktop | remote hosts through `apps/relay` + `host-client` | daemon over WebSocket directly (TCP/Tailscale) or E2E-encrypted Elixir relay | direct |
| Push | expo-notifications, expo-widgets, background monitoring | expo-notifications | expo-notifications, PostHog, Sentry | expo-notifications | — |
| Heavy views | native Swift/Kotlin modules for terminal, review-diff, markdown; shiki | xterm in a WebView; mermaid | shiki, streamdown markdown, flash-list | xterm in WebView, **CodeMirror editor**, Skia | — |
| Build / QA | EAS, expo-updates | EAS, fastlane | EAS, storybook, maestro | EAS, fastlane, maestro, playwright (web) | — |
| Also builds web | no | yes (react-native-web) | yes (`web` script) | yes (react-native-web) | n/a |

Three things every one of them did that we do **not** have to:

1. **Build a relay** (orca's `cloud/`, paseo's Elixir relay, superset's
   `apps/relay`). Claxedo already has the workspace relay with Runtime Access
   Tokens, and a signed-in desktop is already reachable through it.
2. **Build pairing** (QR + key exchange). Claxedo has account auth; the phone
   signs in.
3. **Ship a terminal and editor on the phone.** All four did, and the payoff
   is small next to the cost (native modules, WebView xterm, CodeMirror). This
   plan ships neither. The phone answers and reviews; it does not type in a
   terminal.

Common denominator worth copying: Expo SDK 57 / RN 0.86 / React 19,
expo-router, Tailwind through uniwind, react-query, expo-notifications, EAS
builds and maestro flows. Three of four also build a web target; Claxedo does
not need one — the web app is SolidJS, so nothing could embed a React Native
surface, and the web app already serves anyone who will not install an app.

## Requirements

| # | Requirement |
|---|---|
| M1 | Sign in once with the same account as the web/desktop app; hosted and self-hosted both work; the desktop-only user is told the phone needs a control plane |
| M2 | Cards: every session that needs the user, across all workspaces and machines the account can see, ordered stuck → errored → finished-unseen → running; children nested under parents |
| M3 | Detail: last turn, composer with permission/question controls, plain diff. Nothing else |
| M4 | Push when a session becomes stuck, errors, or finishes; the notification carries "Allow once / Deny" for a permission and opens the card for anything else |
| M5 | Opening a card marks it seen everywhere (`seen_at`) |
| M6 | Cheap: one list query, one detail query, no transcript streaming, no message deltas |

## Design

### Package and stack

`packages/claxedo-mobile`, an Expo app in the existing monorepo. Chosen stack,
each with the reason:

| Choice | Why |
|---|---|
| Expo SDK 57, RN 0.86, React 19 | what t3code and superset ship today; Expo 54 (paseo) and 55 (orca) are behind |
| expo-router | file routes, deep links for free (`claxedo://session/:id` from a push) |
| uniwind + Tailwind | same styling vocabulary as the web app's Tailwind, fastest to write |
| react-query | one list query, one detail query, invalidation on push; no client-side event graph |
| `@better-auth/expo` | the hosted control plane is Better Auth; the Expo client stores the session in `expo-secure-store` |
| expo-notifications + Expo push service | push on iOS and Android with one token type; notification categories give the Allow/Deny actions |
| `@legendapp/list` | the card list; both t3code and superset use it |
| EAS build + maestro | builds and the three critical flows as scripted tests |

Not included, on purpose: a terminal, an editor, a full transcript, shiki, a
WebView, native modules, widgets, voice.

### What it reuses

- **Client.** The shared client package extracted from `claxedo-app`
  (`createClaxedoServerClient` plus the hosted connection handshake), lane S0. It uses `fetch` only, so it runs on Hermes unchanged. The phone
  never talks to a workspace runtime except through the relay hop that client
  already does.
- **Contracts.** `@claxedo/agent-runtime-contract` for session, permission,
  question and diff shapes.
- **Existing routes.** `GET /api/control/sessions` for the inventory,
  `GET /session/:id/messages` (last turn), `GET /session/:id/diff?content=summary`
  ([`routes/diff.ts:126`](../../packages/workspace-runtime/src/routes/diff.ts#L126)),
  the permission and question reply routes, `POST /session/:id/prompt_async`.

### Screens

Two. `app/index.tsx` is the card list; `app/session/[id].tsx` is the detail.
Sign-in is the Better Auth Expo flow; a settings sheet holds sign-out and the
control-plane URL for self-hosted.

**Cards** read one control-plane call, `GET /api/account/attention` (lane S1):
project/workspace, harness, title, status, attention reason, diff counts,
`seen_at`, parent id for nesting. Refresh on foreground and on push. No polling in the
background.

**Detail** reads the last turn (messages route, limit 2) and the diff summary
through the relay, renders the last
user message and the assistant's reply or its pending request, then the
composer. Permission → Allow once / Always / Deny buttons. Question → the
question's options or a text field. Otherwise a text box that sends through
`session_send`. The diff is a flat file list with expandable hunks, plain
monospace, no highlighter.

### Push (the only new server work)

1. **Registration.** `POST /api/account/push-tokens` stores the Expo push token
   per user per device on the control plane; deleted on sign-out.
2. **Attention notifier.** The runtime already syncs session state to the
   control plane (`hosted-session-pull.ts`). The same sync carries the
   `attention` field the feed in S1 reads: pending permission/question ids, error, or turn
   completed. A transition into an attention state for a session the user
   can see sends one push through the Expo push API: title = session title,
   body = the reason, data = `{ sessionId, workspaceId, permissionId? }`.
3. **Actions.** A permission push uses a notification category with
   `allow_once` and `deny` actions; the app handles the action in the
   background by calling the reply route through the client, then refreshes
   the list. Anything else opens `claxedo://session/:id`.
4. **De-dup.** One push per attention transition, none while the session is
   focused on any client (the `seen_at`/focus signal the web app already
   writes), and `seen_at` newer than the transition suppresses it.

Self-hosted node gets the same notifier; the desktop-only user with no control
plane gets no push and the app says so at sign-in.

### Server work this plan owns (and plan 003 later reuses)

| Unit | What | Where |
|---|---|---|
| S0 | Extract `createClaxedoServerClient` + hosted connection handshake into a shared package | new package; `claxedo-app` imports it |
| S1 | `GET /api/account/attention`: sessions needing the user across workspaces and machines, with reason, diff counts, `seen_at`, `parentID`; built on the existing session sync to the control plane plus an `attention` field carried by that sync | `claxedo-server` |
| S2 | `seen_at` per session per user, written on pane focus in the web app and on card open in this app | `claxedo-server` (hosted), local store (desktop) |
| S3 | Child attention on the parent: `permission.asked`/`question.asked` on a `parentID` session upserts the parent's subagent record and emits `subagent-updated` | `workspace-runtime` store |
| S4 | Push-token route and the attention notifier with de-dup | `claxedo-server` |

Plan 003's `sessions_board`, `attention_list` and `session_changes` tools read
S1–S3 unchanged. Nothing in this plan reads an MCP tool.

### Grounding for the S lanes (audit 2026-09-07; details in plan 003 §Grounding E)

| Lane | What exists | What to build |
|---|---|---|
| S0 shared client | `createClaxedoServerClient` is Node-safe (`server-client-contract.ts:161`, three imports, fetch injectable); the app's connection handshake is not (`workspace-relay-connection.ts:1-4` pulls `window.location`) | move the client into `packages/agent-runtime-contract`; write a small Node-safe handshake (two URL builders + fetch + cache) |
| S1 attention feed | `GET /api/control/sessions` returns id/project/title/times only, workspace-scoped (`hosted-core-app.ts:456`, `session-authority.ts:970-987`); **no per-session status anywhere on the control plane**; the pull fetches `/session/status` and discards it (`hosted-session-pull.ts:309-316`); the desktop connector heartbeat carries `workspaceIds` only every 20 s (`host-connector/src/connector.ts:287`); hosted `/runtime/heartbeat` is a no-op (`control.ts:95-103`) | a `session_attention` store on the control plane; persist what the pull sees (cloud); add a per-session attention payload to the connector heartbeat (user-hosted) with `host_online` from `workspaceJson`; the feed read in the shared `session/list.ts` module, mounted on hosted and node |
| S2 `seen_at` | none server-side; client `notification.tsx:47-59` is per-device | table + authority method + write on pane focus; the node's loopback session branch (`control-plane-session.ts:246-262`) has no user and must return no seen state |
| S3 child attention | `SubagentObservation` has no attention field (`subagent-admission.ts:10-27`); pending rows are runtime-only (`workspace-runtime/src/store.ts:733`) | field on the observation and event, both stores, `SubagentView`; emitted on `permission.asked`/`question.asked` for a `parentID` session |
| S4 push | nothing (no expo/apns/fcm/device token); `notifyOwner` (`channels/control-plane.ts:609-670`) does recipient resolution, gating, idempotent claim, daily ceiling | push-token table + route; an Expo transport beside `chat-sdk`/`baileys` in `claxedo-channels/src/registry.ts:3`; the notifier calls `notifyOwner` on an attention transition |

## Phases and acceptance criteria

### Phase 1 — Shell, auth, cards

- S0 and S1; Expo project in `packages/claxedo-mobile`; Better Auth Expo
  sign-in against staging; card list from the attention feed.
- **Accept when** a signed-in phone lists the same sessions the web app shows
  as needing attention, across two workspaces on two machines, and a
  desktop-only sign-in attempt is refused with the control-plane message.

### Phase 2 — Detail, reply, seen

- S2 and S3; last turn, composer, permission/question controls, diff.
- **Accept when** a Claude session stuck on a permission is allowed from the
  phone and continues on the desktop; a Codex question is answered from the
  phone; opening a card clears its unseen state on the web app within one
  refresh.

### Phase 3 — Push

- S4; token registration, notifier, notification actions, deep links.
- **Accept when** a session hitting a permission produces one push within a
  few seconds on iOS and Android, "Allow once" from the lock screen unblocks
  it without opening the app, and no push arrives for a session that is
  focused on the desktop.

### Phase 4 — Release

- EAS builds, TestFlight and Play internal track, maestro flows for the three
  acceptance paths.
- **Accept when** a TestFlight build and an internal Android build pass the
  three maestro flows against staging.

## Definition of Done

- [ ] `packages/claxedo-mobile` builds for iOS and Android from one codebase with the stack above and no terminal, editor, WebView, native module or web target. *Progress:*
- [ ] Sign-in is the shared account through `@better-auth/expo`; hosted and self-hosted both work; desktop-only is refused with a message. *Progress:*
- [ ] The card list is one control-plane query and matches the web app's needs-you set across workspaces and machines; children nest under parents. *Progress:*
- [ ] Detail renders last turn, composer, permission/question controls and a plain diff from two queries; no message-level streaming exists in the app. *Progress:*
- [ ] Opening a card writes `seen_at`; the web app observes it. *Progress:*
- [ ] `GET /api/account/attention` exists on the control plane and the self-hosted node, nests children under parents, and is the only list call the app makes. *Progress:*
- [ ] Push registration and the attention notifier exist on the control plane and the self-hosted node; one push per attention transition; none while focused elsewhere. *Progress:*
- [ ] "Allow once" and "Deny" work from the notification without opening the app. *Progress:*
- [ ] Maestro flows for sign-in, allow-from-phone, and push-allow pass on EAS builds against staging. *Progress:*
- [ ] `bun run test:architecture-ratchets` green; the shared client package is the only cross-package import besides contracts; nothing in the app imports or calls claxedo-mcp. *Progress:*

## Verification

```bash
cd packages/claxedo-mobile && bun run typecheck && bun run test
```
```bash
cd packages/claxedo-mobile && bun run ios
```
```bash
cd packages/claxedo-server && bun run test
```

Each phase's acceptance line names the device, the build and the deployment it
was proven on. A green typecheck is not a proof.

## Execution: parallelize with agents and workflows

| Lane | Owns | Depends on |
|---|---|---|
| S0. Shared client | extract the client package from `claxedo-app`; app and web both import it | nothing |
| S1. Attention feed | `GET /api/account/attention`, `attention` field in session sync | nothing (claxedo-server only) |
| S2/S3. Seen + child attention | `seen_at` route and writes; parent-record attention in the runtime store | nothing |
| A. App shell | Expo project, router, uniwind, Better Auth Expo sign-in, settings | S0 |
| B. Cards + detail | the two screens, react-query wiring, reply controls, diff view | A, S1, S2, S3 |
| C. Push server | push-token route, notifier, de-dup | S1 |
| D. Push client | token registration, categories/actions, background handler, deep links | A, C |
| E. Release | EAS profiles, TestFlight/Play tracks, maestro flows | B, D |

S0, S1, S2/S3 start together, each on one agent. A follows S0; C follows S1;
B follows A and the S lanes; D follows A and C; E last. If plan 003 executes
first it builds S0–S3 and this plan consumes them; they are never built twice.
