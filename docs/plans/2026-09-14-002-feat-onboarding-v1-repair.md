# Onboarding v1: make setup yield to a working product

Status: proposed; not started. Assessed live on 2026-09-14 against the web
surface with `VITE_CLAXEDO_ONBOARDING_V1=true` (flag off by default, so nothing
here ships today). Screenshots of the two screens are in the session's
scratchpad, not in the repo.

## What is wrong today, observed

The feature lives in `packages/claxedo-app/src/features/onboarding/**` (pure
derivation, registry, dismissals, setup surfaces) and is mounted by
`packages/claxedo-app/src/app/workbench/rail/onboarding-empty-state.tsx`
through `rail-workbench-canvas.tsx`. Its mode comes from
`setup-shell-state.ts::setupShellMode`.

1. **The form covers a working product.** A project with eight sessions,
   completed turns and Tasks tools called from inside them still opens on
   "Set up Claxedo, Step 1 of 2" as an overlay (`onboardingOverlayDirectory`
   in `rail-workbench-canvas.tsx`) with the rail fully live behind it.
2. **Two reads that never come true.** `setupShellMode` hides the form when a
   first turn completed or the AI is runnable.
   - `hasFirstTurn` reads `session.lastTurn?.status === "completed"` off the
     session inventory (`onboarding-empty-state.tsx:143`). No server route
     serves `lastTurn` on inventory rows; the only writer is
     `session-screen.tsx:636`, which copies the runtime's per-session info into
     the row while that screen is mounted. After a reload the field is gone, so
     the check is false for every session the current tab has not opened.
   - `hasRunnableAI` (`state.ts:149`) needs a verified credential row or a
     non-empty `runnableHarnesses`. The local store here has no credential
     rows (`/api/claxedo/credentials` → `[]`) because the machine's Claude Code
     login is harness-native, and `runnableHarnesses` is set only by
     `AIConnectSurface` after the user presses "Check my logins"
     (`autoDiscover` is true only when opened from the go-further card).
3. **The first question is the cloud question.** `registry.ts` orders
   `destination` first. The feature's own `AGENTS.md` records the opposite
   lesson: cloud sessions are a pull after the first local turn, and the
   "push it first" design failed its stress test.
4. **Manual steps that could be automatic.** "Your logins" says "Nothing to
   paste" and then requires a button press before Next enables; the disabled
   Next carries its reason only as a hover title (`nextBlockedReason`).
5. **No way out of a required step.** `skipAction` exists only for optional
   steps. The `"setup"` and `"checklist"` dismissal ids exist in
   `dismissals.ts` and are read by `setupShellMode`, but nothing writes them;
   `mode === "checklist"` also has no renderer in the shell.
6. **The first-project canvas is shadowed.** With no project,
   `rail-workbench-canvas.tsx` renders `OnboardingEmptyState` with the
   canvas as `fallback`; the form wins whenever mode is not `hidden`, and
   nothing can make it hidden, so `FirstProjectCanvas` is unreachable under
   the flag.

## Goal

Setup shows exactly when it has something to ask, asks it in the order the
funnel notes prescribe, verifies by observing rather than by asking, and
always has a visible way out. A user whose sessions already work never sees
it.

## Design

One rule for visibility, computed from server-owned facts:

- **First turn** is a fact the server serves. The inventory rows the rail
  already reads gain the runtime's `lastTurn` outcome (the same value
  `session-screen.tsx` copies today), produced once by the inventory owner
  for both deployments, so `hasFirstTurn` is true after a reload and on a
  second device.
- **Runnable AI** is observed at mount. On a local server the shell runs
  `discoverAIConnections` (`ai-connect-api.ts:20`) once when setup becomes
  visible and feeds `runnableHarnesses` from it; the "Check my logins" button
  remains for re-checks. A detected harness login is a runnable AI.
- **Order**: project → AI → first turn. Cloud sessions and remote access move
  out of the required path and become go-further cards after the first turn,
  next to the two cards that exist (`go-further.ts`). The `destination`
  answer remains a stored fact for the AI step's method list, defaulting to
  `local` until the cloud card is taken.
- **No project** is the first-project canvas, not a row inside another step.
  The canvas keeps its own affordance; setup's project step is satisfied by
  `hasProject` and renders nothing of its own.
- **A way out on every screen**: "Skip setup" writes the `"setup"` dismissal
  and the shell shows the checklist card the mode already names, rendered in
  the empty-draft composer area rather than as an overlay; "Don't show again"
  writes `"checklist"`. The overlay host goes away: setup is either the empty
  canvas's content or a card, never a layer over a live rail.
- The disabled Next states its reason in the footer text, not only as a hover
  title.

## Change points

- `packages/claxedo-app/src/features/onboarding/registry.ts` — steps become
  `project`, `ai`; `destination` and `remote-access` leave the required path;
  `education` strings and `verify` adjust.
- `packages/claxedo-app/src/features/onboarding/setup-shell-state.ts` —
  `setupShellMode` unchanged in shape; inputs come from the new facts.
- `packages/claxedo-app/src/features/onboarding/go-further.ts` — add the
  `cloud` and `remote-access` cards; their actions open the existing
  `DestinationSurface` (cloud branch) and `RemoteAccessSurface`.
- `packages/claxedo-app/src/features/onboarding/dismissals.ts` — no new ids;
  the shell gains writers for `"setup"` and `"checklist"`.
- `packages/claxedo-app/src/app/workbench/rail/onboarding-empty-state.tsx` —
  discovery at mount; checklist renderer; Skip setup; footer reason; remove
  the overlay branch.
- `packages/claxedo-app/src/app/workbench/rail/rail-workbench-canvas.tsx` —
  the no-project screen is `FirstProjectCanvas`; setup renders only inside
  the empty-draft composer region; `onboardingOverlayDirectory` is deleted.
- Session inventory rows carry `lastTurn`: find the one owner of the local
  `/api/claxedo/session` inventory and the hosted `session-list` rows and add
  the runtime's `lastTurn` there; delete the client-side copy in
  `session-screen.tsx:636/863` once the server serves it (one owner).
- `packages/claxedo-app/src/features/onboarding/AGENTS.md` — the rationale
  section already argues for this order; update the step list it implies.

## Definition of done

- [ ] With the flag on, a project whose sessions have completed turns opens with
      no setup form after a reload and in a second browser profile.
      Progress:
- [ ] With the flag on and an empty credential store, a machine with a Claude
      Code, Codex or Cursor login shows the AI step as done without a click.
      Progress:
- [ ] With no project, the first screen is `FirstProjectCanvas`; creating a
      project moves setup to the AI step.
      Progress:
- [ ] Cloud sessions and remote access appear only as go-further cards after
      the first completed turn; taking the cloud card opens the sandbox key
      and code host blocks that exist today.
      Progress:
- [ ] Every setup screen has Skip setup; Skip writes `"setup"` and the
      checklist card appears in the composer's empty state; "Don't show again"
      writes `"checklist"` and nothing of setup remains.
      Progress:
- [ ] The rail is never interactive behind a setup overlay, because there is no
      overlay.
      Progress:
- [ ] The disabled Next shows its reason as visible text.
      Progress:
- [ ] Tests: `setup-shell-state`, `registry`, `navigation`, `home-view` cases
      for the new order and the new facts; an inventory-route test that a row
      carries `lastTurn`; a rendered test that discovery runs at mount on a
      local server and not on hosted; Playwright proof of the first two
      checkboxes against a real local stack in both themes.
      Progress:
- [ ] The onboarding funnel events (`funnel.ts`) still fire in order:
      `setup_form_shown`, `step_done` per step, `first_turn_ok`.
      Progress:

## Execution: parallel lanes with disjoint ownership

Fable subagents only. Four lanes, one owner each; the orchestrator reviews
every diff and reruns its gates before accepting.

- Lane 1, inventory fact: the server inventory owner(s) and
  `session-screen.tsx` (remove the client copy). Gate: local-server and
  claxedo-server vitest for the inventory routes; app typecheck.
- Lane 2, derivation: `features/onboarding/{registry,setup-shell-state,
  go-further,home-view,navigation,state}.ts` and their tests. Pure; `bun test`.
- Lane 3, shell: `onboarding-empty-state.tsx`, `rail-workbench-canvas.tsx`,
  the checklist renderer, discovery at mount, Skip setup. Vitest under the
  app; Playwright proof on the local stack.
- Lane 4, surfaces: `destination-surface.tsx`, `remote-access-surface.tsx`
  reached from cards; `setup-page.tsx` footer reason. Vitest under the app.

Lanes 2 and 3 share the step-id vocabulary; lane 2 lands first and lane 3
builds on its commit. Lanes 1 and 4 are independent of both.
