---
title: "feat: Onboarding as a full-page setup flow"
date: 2026-07-25
type: feat
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
supersedes_ui_of: ./2026-07-17-002-feat-onboarding-v1-implementation-plan.md
flag: VITE_CLAXEDO_ONBOARDING_V1
---

# feat: Onboarding as a full-page setup flow

## Goal Capsule

- **Objective:** Replace the floating setup card with a **full-page, one-step-at-a-time
  setup route** that a first-run user can finish without ever asking "what is this
  asking me, can I go back, and did that work?"
- **Method:** Keep the registry/state machine (`registry.ts`, `state.ts`, `home-view.ts`)
  — the *logic* is sound. Replace the *presentation* (`setup-shell.tsx` + `.css` +
  the overlay mount) and decompose the Connect-AI step into a branching sub-flow
  with per-item outcomes.
- **Authority:** `packages/claxedo-app/src/features/onboarding/**`,
  `packages/claxedo-app/src/app/workbench/rail/rail-workbench-canvas.tsx`,
  `packages/claxedo-app/src/app/routes/**`, and the credential discovery seam in
  `packages/claxedo-server/src/credentials/{discovery,sync}.ts`.
- **Stop conditions:** Stop W5 if the discovery selection-key change cannot keep
  `save-discovered` backward compatible with the current client (the desktop app
  ships client and server together, but the hosted control plane does not).
  Stop W4 if `DialogAIConnect` (`app/dialogs/connect-ai.tsx`) cannot be recomposed
  from the same sub-surfaces — the dialog is a real second consumer and must not fork.

---

## 1. What is wrong today, with the code that causes it

Every item below is a reviewer-visible defect from the 2026-07-25 desktop run
(`Claxedo Dev`, onboarding v1 on, fresh profile), traced to its source.

| # | Symptom | Cause |
|---|---|---|
| D1 | "No backdrop" — the card floats while the composer dock and rail stay live behind it | It is neither modal nor page. `rail-workbench-canvas.tsx:78` mounts `OnboardingEmptyState` with `overlay`, which only applies `absolute inset-0 z-20 bg-background-base` (`onboarding-empty-state.tsx:197`) **inside the workbench pane** — no scrim, no focus trap, no Escape, and the composer/dock render outside that box. |
| D2 | Checkmarks look broken and are the only colored thing on screen | `setup-shell.tsx:107` renders raw text glyphs `✓` / `—` inside a 1.1rem circle, and `setup-shell.css:75-78` recolors the ring and glyph to `--icon-success-base`. Native `<input type="checkbox">` in `ai-connect-surface.tsx:242` renders the OS blue check, which matches nothing else in the app. |
| D3 | No way to go back; no idea what is skippable | There is no back affordance at all. Step navigation is "click a row in the list", and `Skip for now` renders per-row (`setup-shell.tsx:114`) only when `mode === "form" && skippable && !done && !locked` — so it appears on some rows, in the row body, with no statement of consequence. |
| D4 | Connect-AI is enormous and the whole dialog scrolls | The step body has no scroll container of its own (`.onboarding-content-pane` is a plain `padding` box, `setup-shell.css:102`); the scroll lives on the outer wrapper (`onboarding-empty-state.tsx:196`, `overflow-auto`). Everything in the step is rendered at once: a 2-column card grid + scope selector + discovery results + status banners (`ai-connect-surface.tsx:131-296`). |
| D5 | "This machine / My cloud workspaces" reads as unexplained tabs | They are `Button`s with `variant="primary"` for the selected one under the heading "Available to" (`ai-connect-surface.tsx:213-226`). The label names a *property*, not a *question*, and the control shape says "tab" while the semantics are "radio". |
| D6 | Save failed | See §2 — three separate defects, only one of which I could confirm from code alone. |
| D7 | "Do this later" / "Hide" offered on essential steps | `setup-shell.tsx:89-92` renders the dismiss action unconditionally in the heading, for every mode, including when zero steps are done. |
| D8 | Wants a page, not a dialog | The shell is `width: min(52rem, 100vw - 2rem)` centered in a pane (`setup-shell.css:1-8`). |

### Design defects not in the user's list, found while reading

- **D9 — the step list and the step body disagree about "active".** The list highlights
  `activeStep`, but selecting a *done* or *locked* step silently falls back to the
  computed active step (`onboarding-empty-state.tsx:214-217`), so a click can appear
  to do nothing.
- **D10 — locked steps are dead rows.** `Add compute` and `Access remotely` render as
  permanently disabled buttons with their lock reason as body copy. Three of the four
  visible rows on first run are things the user cannot do.
- **D11 — no keyboard model.** No focus management on step change, no Enter-to-advance,
  no `aria-current` on the active step.

---

## 2. The save failure — REPRODUCED (W0, 2026-07-25)

**It is not a save failure. The save succeeds; a refreshable credential is imported as a
dead snapshot, and the UI reports the whole batch as one failure.**

### 2.0 Reproduction

Method: `claxedo-server` on port 3099 with `CLAXEDO_DATA_DIR` pointed at a throwaway
profile and the real `$HOME` (so discovery sees the same credentials as the failing run).
No UI involved — the exact three HTTP calls the client makes. The throwaway store was
deleted afterwards; it held real token material.

| Call | Result |
|---|---|
| `POST /api/claxedo/credentials/discover` | **200** — the same 4 items as the screenshot: `codex-acp` ×2 (distinct masked account ids, `~/.codex/accounts/*.auth.json`), `claude-acp` + `claude-sdk` (no account id, `macOS Keychain or ~/.claude/.credentials.json`) |
| `POST /api/claxedo/credentials/save-discovered` (all 4, `scope: "local"`) | **200** — `saved` contains all 4 credential ids. **No error, nothing rejected.** |
| `POST /api/claxedo/credentials/{id}/verify` ×4 | `codex-acp` → **`expired`**, `codex-acp` → **`expired`**, `claude-acp` → **`ok`**, `claude-sdk` → **`ok`** |

So B2 and B3 below are real but were **not** what the user hit, and the client-side
count-mismatch throw never fired. The failure is B0 + B1.

### 2.1 B0 — refreshable OAuth credentials are imported as dead snapshots *(root cause)*

The Codex collector reads `~/.codex/accounts/*.auth.json`, which contains
`access_token` **and** `refresh_token`, and requires both to be present
(`sync.ts:183`). It stores both in the secret — and sets
`fresh_until = jwtExp(access)` (`sync.ts:206`), i.e. the **access** token's expiry.
`discovery.save()` copies that to `expires_at`, and then:

```ts
// credentials/verify.ts:13
if (credential.expires_at !== null && credential.expires_at !== undefined && credential.expires_at <= now()) {
  return "expired"
}
```

The verifier short-circuits on a local timestamp — no network call, and **no attempt to
use the refresh token that is sitting in the same secret**. On this machine the two Codex
accounts last refreshed on 2026-04-09 and 2026-06-02; the Codex CLI refreshes them
transparently on use, so both subscriptions work fine outside Claxedo. Claxedo imports
them and immediately declares them expired, permanently — re-verifying will never
succeed, because nothing ever refreshes the token.

Every ChatGPT-subscription user whose access token is older than ~1 hour hits this on
their first onboarding. That is the default state of any Codex install that has been idle.

### 2.2 B1 — one failure hides three outcomes *(what the user saw)*

`complete()` (`ai-connect-surface.tsx:111-127`):

```ts
const failed = results.find((result) => result.result !== "ok")
const current = failed ?? results[0]
transition({ type: "verification-result", result: current.result })
if (failed) { props.emit?.({ name: "step_verify_failed", ... }); return }   // ← early return
results.forEach(...); await props.onConnected?.(results)
```

With `[expired, expired, ok, ok]` the surface renders exactly one box —
"Connected, not working" + the `expired` copy — and **returns before calling
`onConnected`**. The two credentials that verified `ok` are never mentioned and never
reported to the caller. From the user's seat: "it failed to save credentials, and it
won't move on." Both halves of that sentence are the UI lying about a partially
successful save.

### 2.3 Still-real defects found by code reading (not this failure)

- **B1b — the count-mismatch throw.** `saveDiscoveredAIConnections` (`ai-connect-api.ts:53`)
  throws `"Credential discovery save returned incomplete results"` whenever
  `saved.length !== items.length`, discarding the credentials that *did* save. It did not
  fire in this run (4 sent, 4 saved) but it is the same all-or-nothing reflex as B1.
- **B2 — the discovery scan expires silently.** The server stash has a 5-minute TTL and is
  single-use (`discovery.ts:6`, `stash.delete(...)` after save). Reading the scope
  explainer for five minutes is enough to make `Save selected` fail with
  `discovery_expired` → the client shows the generic server message and leaves the stale
  result list on screen. Nothing tells the user to scan again.
- **B3 — latent duplicate-selection rejection.** The collector keys items by
  `provider_id + kind + account_id` (`sync.ts:317`) but the discovery stash keys them by
  `provider_id + masked account_id` only (`discovery.ts:47,67`). Two collected items that
  differ **only in `kind`** therefore collapse to one stash entry while both still render
  as selectable rows; selecting both sends two identical keys and the server rejects the
  **whole batch** with `discovery_duplicate_item` → 400 (`discovery.ts:82`).

**D12 — the two Claude rows are byte-identical in the UI.** They are `claude-acp` and
`claude-sdk` (`sync.ts:396-397`) — different provider ids, so they save fine, but they
render with the same label and the same origin (`sync.ts:308`) and no account id. The
user is asked to pick between two rows they cannot tell apart. Confirmed in the W0
discovery response.

---

## 3. Design direction

### 3.1 Concept

**"The app, minus everything you haven't earned yet."** Setup is not a guest modal
sitting on top of the product; it is the product with one job on screen. That means:
the app's own chrome and type scale, hairline rules instead of nested boxes, a single
column of text at a readable measure, and exactly **one primary action per screen**.

The distinctiveness comes from restraint and scale contrast, not decoration: a 28px
step title against 13px body copy, an 11px uppercase eyebrow, a 2px progress hairline,
and a single accent moment reserved for the one thing that is genuinely worth
celebrating (a verified credential).

**Principles**

1. One decision per screen. If a screen has two primary buttons, it is two screens.
2. Every screen answers: where am I, what is this for, what happens if I do it, how do I go back.
3. Colour carries meaning exactly once (verified). Everything else is monochrome.
4. Only the body scrolls. Header and action bar are always on screen.
5. Nothing that cannot be done is shown as a thing to do.

### 3.2 Page skeleton

```
┌──────────────────────────────────────────────────────────────┐
│ Set up Claxedo                            Step 2 of 4        │  56px, hairline bottom
│ ▬▬▬▬▬▬▬▬  ▬▬▬▬▬▬▬▬  ────────  ────────                       │  2px segments
├──────────────────────────────────────────────────────────────┤
│                                                              │
│            CONNECT YOUR AI                    ← eyebrow 11px │  ↕ the only
│            Pick how you want to connect       ← h1 24/28     │    scroll
│            A verified credential unlocks…     ← lede 14px    │    container
│                                                              │
│            ┌──────────────────────────────────────────┐      │  measure: 44rem
│            │ Find credentials on this computer     ›  │      │  rows, not cards
│            ├──────────────────────────────────────────┤      │
│            │ Paste an API key                      ›  │      │
│            └──────────────────────────────────────────┘      │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│ ‹ Back                                    [ Continue ]       │  64px, sticky,
└──────────────────────────────────────────────────────────────┘  hairline top
```

- Grid: `grid-rows-[auto_1fr_auto]`, `height: 100%`, `background: var(--background-base)`.
- Measure `min(44rem, 100% - 3rem)`, centred; body `padding-block: 2.5rem 4rem`.
- Vertical rhythm: `2.5rem` between blocks, `1.5rem` inside a block, `0.75rem` between
  a label and its consequence line.
- Below `900px` the progress labels collapse to the counter alone; below `640px` the
  action bar stacks with the primary action full-width and first in DOM order.

### 3.3 Progress rail

Four `flex-1` segments, `height: 2px`, `gap: 0.25rem`.
`done → var(--text-strong)`, `current → var(--text-base)` with a `220ms ease-out`
width fill, `upcoming → var(--border-weak-base)`, `locked → var(--border-weak-base)`
with `opacity: .5`. Labels sit under the segments at `text-11` `--text-weaker`,
`aria-hidden` (the accessible name lives on the counter). The counter uses
`font-variant-numeric: tabular-nums` so it does not jitter between steps.

### 3.4 State marks — monochrome rule

| State | Mark | Token |
|---|---|---|
| Done | `<Icon name="check-small" size="small" />` | `--text-weak` |
| Current | filled 6px dot | `--text-strong` |
| Upcoming | `<Icon name="circle-dashed" />` | `--border-base` |
| Locked | no mark; the row is not rendered as an action at all | — |
| Verified credential (the one accent) | `<Icon name="circle-check" size="small" />` + text | `--icon-success-base` |

Delete `setup-shell.css:75-78` (green ring) and the `✓`/`—` text glyphs. Replace the
native `<input type="checkbox">` in the discovery list with the kit `Checkbox`
(`@opencode-ai/ui/checkbox`), which is already themed monochrome.

### 3.5 Motion

Step transition: `opacity 0→1` + `translateY(8px→0)`, `160ms cubic-bezier(.2,0,0,1)`,
on the body only (header and action bar never move). Progress fill `220ms`. Row hover
`background 90ms`. All of it wrapped in `@media (prefers-reduced-motion: reduce)` →
`animation: none; transition: none`.

### 3.6 The rail during setup

The rail stays mounted — removing it would make the page feel modal again, and setup
is re-enterable from a rail entry, so it cannot be a surface that hides its own
entry point. But it obeys the same rule as the step list: **never show what cannot
be done yet.**

| Rail item | First run (no project, no credential) | Re-entered setup (has project/sessions) |
|---|---|---|
| `Set up Claxedo` / `Finish setup · N left` | present, marked active (`aria-current="page"`) | present, marked active |
| `New Project` | present — it *is* step 1's action, and must dispatch the same handler, not a second path | present |
| Projects / sessions tree | absent (there is nothing in it) | normal |
| `Documents`, `Marketplace`, `WorkGraph` | absent — each needs a workspace or a credential | normal |
| Workspace footer (`Local workspace`) | present | present |
| `Settings`, account menu, Diagnostics | present | present |

Absent, not disabled: a greyed row is the rail-level version of D10. The gating memo
lives beside the page's own state (`home-view.ts`), so the rail and the step list can
never disagree about what is reachable.

### 3.7 Copy rules

- Headings are the user's goal, not our noun: "Pick how you want to connect", not
  "Connect your AI configuration".
- Every destructive-ish or deferring action states its consequence in the label:
  `Skip — add compute later`, not `Skip for now`.
- Every option row has exactly one line of consequence copy under it.
- Never surface a raw server error code; map to a sentence + a repair action.

---

## 4. Screen-by-screen specification

### S1 · Open a project *(required)*

Eyebrow `STEP 1 OF 4` · h1 "Choose where your first task runs" · lede from
`registry.ts` education. Body: the recent-directories list if any, plus
`Open a project…`. Action bar: primary `Open a project`, **no** skip, **no** back.

### S2 · Connect your AI *(required)* — the branching sub-flow

**S2a · Method chooser.** Full-width `<button>` rows, hairline separated, trailing
`chevron-right`, hover `--surface-base-hover`, `:focus-visible` ring from the kit.

| Row | Consequence line | Shown when |
|---|---|---|
| Find credentials on this computer | "Reuses the Claude Code or Codex CLI logins already on this machine. Nothing is saved until you pick." | `localDiscovery` |
| Choose a provider | "Anthropic, OpenAI, Copilot, or any other provider — sign in or paste a key." | always |
| Connect from a terminal | "Push an existing subscription from the CLI." | `!localDiscovery` |

Back from S2b/S2c returns here; Back from S2a returns to S1.

**S2b · Detect results.** One row per credential:

```
☐  Claude Code login · agent SDK                       Verified ✓
   macOS Keychain                                      
☐  Claude Code login · ACP adapter                     Couldn't verify — key rejected · Retry
   macOS Keychain
```

- Kit `Checkbox`, label, origin, **disambiguating suffix** when two rows share a label.
- A per-row status column: `idle → Saving… → Verified | <reason> · Retry`.
- Primary action carries the count: `Save 2 connections` (tabular numerals).
- Empty result → "No supported logins found on this machine" + `Paste an API key instead`.
- Expired scan → inline "This scan expired." + `Scan again` (auto-triggered on
  `discovery_not_found` / `discovery_expired`).

**S2c · Choose a provider — reuse the composer's provider surface, do not fork it.**

Today this screen is two hardcoded buttons, `anthropic` and `openai`
(`ai-connect-surface.tsx:24-27`), plus its own key field. That is a fork of a better
surface the app already ships: `DialogSelectProvider` (`app/dialogs/select-provider.tsx`)
renders the **whole catalog** from `useProviders()` — searchable `List`, `ProviderIcon`,
Popular/Other grouping, per-provider notes, a Custom-provider entry — and hands off to
`DialogConnectProvider`, which already knows each provider's *methods* (OAuth vs API key,
e.g. `ChatGPT Plus or Pro` for Codex) and is fully i18n'd. Onboarding reaching that catalog
through two buttons is why the step feels both cramped and incomplete.

So S2c is the same provider surface, rendered **inline in the page body** rather than as a
dialog stacked on top of it:

- **S2c-i · provider list** — same `List` configuration as `DialogSelectProvider`
  (search autofocus, `popularProviders` grouping, `filterKeys: ["id","name"]`, custom entry).
  Extract that list body into `features/onboarding/ai-connect/provider-list.tsx` and have
  the dialog render it too, so there is one list with one sort order.
- **S2c-ii · connect form** — extract the body of `DialogConnectProvider` into
  `ProviderConnectForm` (method chooser → OAuth flow or API-key field → save). The dialog
  keeps its own shell; the setup page renders the same form in the step body with the page's
  action bar driving submit.
- **Scope** — the form takes an optional `scope` prop. Onboarding passes it so the
  credential is written with `scope`/`source` the way `connectAIKey` does today
  (`ai-connect-api.ts:60`); the dialog keeps its current unscoped `PUT`. This is the one
  real behavioural difference between the two callers and it must be a prop, not a fork.

Consequence: the hardcoded provider pair, the duplicate key field, and the
`onProviderConnect` → `dialog.show(DialogConnectProvider)` hop (`onboarding-empty-state.tsx:150`)
all disappear, and onboarding gains OAuth-capable providers for free.

Then the scope question, below.

**Scope question** (replaces "Available to"): heading is a real question —
"Where should this credential be usable?" — with two radio rows:

- `Only this computer` — "It never leaves this machine."
- `This computer and my cloud workspaces` — "Cloud agents can use it. Subscription
  credentials in the cloud may be subject to your provider's terms."

Rendered **only** when a cloud workspace exists; otherwise the local scope is implied
and stated in one footnote line. This removes a decision from the common case.

### S3 · Add compute *(optional)* / S4 · Access remotely *(optional)*

Unchanged content (`RemoteAccessSurface` etc.), new frame. Action bar shows
`Skip — add compute later` / `Skip — set this up later` next to the primary CTA.
If a step is locked, it is **not** a screen: it appears on S5 as "what's next".

### S5 · You're set up

Replaces `mode: "go-further"`. Recap of what is proven (monochrome checks), then the
Go-further cards, then a single primary `Start your first task` that routes to the
composer. Rail keeps a quiet `Finish setup · 2 left` entry while optional steps remain.

---

## 5. Exits policy (fixes D7)

| Step | Rail exit | Footer skip |
|---|---|---|
| project | none | none |
| ai | none | none |
| compute | `Finish later` | `Skip — add compute later` |
| remote-access | `Finish later` | `Skip — set this up later` |

`Finish later` leaves the page and writes the existing `checklist` dismissal, which now
renders as a rail entry rather than a second card layout. Consequence: the
`checklist` branch of `setupShellMode` (`setup-shell-state.ts`) stops being a *layout*
and becomes a *location*.

---

## 6. Phases

Each phase lists exact files and its own acceptance criteria. `Progress:` slots are
for the implementing agent.

### W0 · Reproduce the save failure before changing anything — ✅ DONE 2026-07-25
- **Accept:** the failing request's status, body, and selected item keys are recorded in
  the plan's evidence section. No redesign work starts on the AI step until this exists.
- **Result:** §2. All three HTTP calls return 200; the save is not the failure. Root cause
  is **B0** (refreshable Codex OAuth imported as a dead snapshot, verifier short-circuits
  on `expires_at` without refreshing) presented through **B1** (first-failure-wins banner
  that hides two successful credentials and never calls `onConnected`). The planned
  "surface the server error code" instrumentation is **not needed** — there is no server
  error to surface; it would have been busywork against a fault that lives in the verifier
  and in the client's result reduction.
- Progress: complete. Reproduced against an isolated `CLAXEDO_DATA_DIR` with the real
  `$HOME`; throwaway store deleted afterwards (it held real token material).

### W0b · Codex credential lifecycle — ✅ DONE 2026-07-25

B0 was the first of **three** independent faults on the path from "user has a working
ChatGPT subscription" to "Claxedo says it works". Each alone is sufficient to fail
onboarding, which is why the first fix alone did not flip the live result.

**B0 — the verifier never refreshed.** `verify.ts` returned `expired` from a local
timestamp. Now: a stale credential whose secret carries a refresh token is renewed
(`credentials/refresh.ts`, form-encoded `grant_type=refresh_token`, request shape matched
to the two shipped implementations in this repo), the provider is then probed with the new
token, and the caller is handed the renewed secret to persist. Only a *rejected* refresh is
`expired` — and it is now logged, never silently assumed.

**B0a — the collector imported the wrong file.** `~/.codex/auth.json` and
`~/.codex/accounts/<email>.auth.json` can hold the **same account** with different tokens;
`sync.ts` preferred the accounts directory wholesale. On the reporter's machine that meant
importing a June copy (dead) while a token refreshed *yesterday* sat in `auth.json`.
`codexAuthCandidates()` now compares `last_refresh` across both sources and keeps the
freshest per account — and accounts that exist only in `auth.json` are no longer dropped.

**B0b — the Codex probe was malformed.** `chatgpt.com/backend-api/codex/responses` is not
the public Responses API. Observed 2026-07-25 against a live subscription: a string `input`
is `"Input must be a list"`, `store: true` is `"Store must be set to false"`,
`stream: false` is `"Stream must be set to true"`, and `max_output_tokens` is
`"Unsupported parameter"` — four separate 400s, none of which map to a health value, so
every valid ChatGPT plan became a hard `credential_verification_failed`. **A route test was
pinning the broken shape** (`credential.test.ts` asserted `max_output_tokens: 1`), so the
suite was green against a request no subscription could answer.

Two consequences fell out of B0a and are fixed with it:
- `getCredentialByProvider` ordered by `updated_at` — "whichever was written last". With
  two accounts for one provider, write order decided which token every session used. Now
  ranked by usable status, not-expired health, furthest-out expiry, then recency.
- The deprecated `syncLocalCredentials` path never carried `fresh_until` into `expires_at`,
  so credentials imported that way had no expiry at all and nothing downstream could tell a
  fresh account from a months-old one.

**Token write-back (owner decision, 2026-07-25):** a successful refresh mirrors the new
pair back into the matching `~/.codex` file (`credentials/codex-auth-file.ts`), the same
contract the Codex harness driver already honours, so rotation cannot strand the user's
CLI. Conservative by construction: existing files only, matched on `tokens.account_id`,
atomic write at `0600`, and every failure logged rather than raised.

- **Accept:** ✅ a stale-but-refreshable Codex credential verifies without the local
  short-circuit; ✅ regression tests pin the refresh grant, the renewed-secret rewrite, and
  the Codex request shape; ✅ a genuinely revoked credential still reports a failure.
- **Live evidence (real credentials, isolated `CLAXEDO_DATA_DIR`, 2026-07-25):** the same
  four credentials that produced `expired, expired, ok, ok` before now produce
  **`rate_capped, expired, ok, ok`**. The first Codex account is authenticated and answering
  — 429 `usage_limit_reached`, quota resets in ~93h — where it was previously called dead.
  The second is genuinely expired: its refresh token was rejected 401 (last refreshed
  2026-04-09). `~/.codex` was byte-identical to its backup afterwards, as expected when no
  refresh succeeds.
- **Files:** `credentials/{refresh,verify,codex-auth-file,sync,registry}.ts`,
  `control-plane/services.ts`, `routes/credential.ts`,
  `provider-auth/openai-oauth.ts` (extracted constants).
  Tests: `credentials/{refresh,verify,codex-auth-file}.test.ts` (new, 48 cases),
  `credentials/sync.test.ts` +2, `routes/credential-verification.integration.test.ts` +2,
  `routes/credential.test.ts` (corrected). 192 green, typecheck clean.
- Progress: complete.

### W0c · Follow-ups this opened *(not blocking the UI work)*
- [ ] `rate_capped` is not `ok`, so `hasUsableCredential` stays false and the AI step does
      not complete for a valid-but-quota-exhausted subscription. Decide whether a plan at
      its limit is a *usable* credential (recommendation: yes, with the reset time shown) —
      belongs with W5's per-item outcomes.
- [ ] Claude credentials carry no expiry or refresh token at all (`sync.ts:claudeOAuthItem`
      stores only the access token), so they can never be refreshed. Same fault class, no
      data to fix it with yet.
- [ ] The Codex probe spends a real request against the user's quota on every verify.
      Consider a cheaper authenticated endpoint.

### W1 · Navigation model (pure TS, TDD)
- New: `features/onboarding/navigation.ts` + `navigation.test.ts`.
- Owns: ordered visible steps, required vs optional, `next/back/skip` resolution,
  deep-link mapping `/setup/:step ⇄ ?onboarding=<step>`, and the rule that locked steps
  are never navigable. Make illegal states unrepresentable: a `SetupLocation` union of
  `{ step, substep }`, not free-floating signals.
- **Accept:** tests assert every transition from every state, including "selecting a
  done step is a no-op" (D9) and "locked steps are absent from the order" (D10);
  no DOM in this file; `bun run test` green.
- Progress:

### W2 · Page shell + route + redirect
- New: `app/routes/setup.tsx`, `features/onboarding/page/{setup-page,setup-rail,setup-actions}.tsx`,
  `features/onboarding/page/setup-page.css`.
- Changed: `app/entry/app.tsx` (register `/setup` **before** `/:dir`, like `/marketplace`;
  add the marker to `APP_ROUTE_SPINE_REQUIRED` in `src/architecture/scanners.ts`),
  `app/workbench/rail/rail-workbench-canvas.tsx` (delete the `overlay` mount; redirect to
  `/setup` when `home-view` says `form`).
- **Accept:** `/setup` renders header + empty body + action bar with the skeleton in §3.2;
  only the body scrolls at 640px height; no `absolute inset-0` overlay remains in the
  canvas; route-spine guard green.
- Progress:

### W3 · Steps 1, 3, 4 in the new frame
- New: `features/onboarding/steps/{step-project,step-compute,step-remote-access}.tsx`.
- Deleted: `features/onboarding/setup-shell.tsx`, `setup-shell.css`.
- **Accept:** each step renders eyebrow/h1/lede/body/actions; back works from every step
  after the first; `aria-current="step"` on the active segment; keyboard: Tab reaches the
  primary action, Enter activates it.
- Progress:

### W4 · Connect-AI sub-flow
- New: `features/onboarding/ai-connect/{method-chooser,detect-results,provider-list,scope-question}.tsx`
  and `features/onboarding/ai-connect/provider-connect-form.tsx` (extracted from
  `app/dialogs/connect-provider.tsx`, plus an optional `scope` prop).
- Changed: `app/dialogs/select-provider.tsx` and `app/dialogs/connect-provider.tsx` render
  the extracted list/form so there is exactly one of each; `ai-connect-surface.tsx` becomes
  a thin composition so `DialogAIConnect` (`app/dialogs/connect-ai.tsx`) keeps working;
  `ai-connect-state.ts` gains per-item save/verify state.
- Deleted: the hardcoded `providers` pair in `ai-connect-surface.tsx:24-27` and its
  bespoke key form.
- **Accept:** the AI step fits 640px height without inner scroll at every sub-screen; the
  provider list is the full catalog with search and Popular/Other grouping, matching the
  composer's connect flow item-for-item; a provider with an OAuth method (e.g. Codex
  "ChatGPT Plus or Pro") is connectable from setup; the scope question is absent when no
  cloud workspace exists; both dialogs still render and connect; component tests cover
  chooser → provider list → connect form → verified, and chooser → detect → save → verified.
- Progress:

### W5 · Per-item outcomes + server key fix
- Changed: `ai-connect-api.ts` (return per-item results; stop throwing on count mismatch),
  `ai-connect-surface.tsx` (per-row status, per-row retry),
  `claxedo-server/src/credentials/discovery.ts` (selection key includes `kind`; per-item
  errors instead of whole-batch 400; return already-saved items rather than failing),
  `credentials/sync.ts` (disambiguate `claude-acp` vs `claude-sdk` labels — D12).
- **Accept:** saving 4 credentials where 1 fails keeps the 3 successes, shows one failing
  row with a reason and a working Retry; two collected items differing only in `kind` are
  both selectable and both save (B3 regression test at the server); server tests green.
- Progress:

### W6 · Exits, rail entry, final screen
- Changed: `setup-shell-state.ts`, `home-view.ts`, rail entry point.
- New: `features/onboarding/steps/step-done.tsx` (S5).
- **Accept:** no exit affordance on project/AI; skip labels state their consequence;
  `Finish later` returns to the app and leaves a `Finish setup · N left` rail entry that
  reopens `/setup` at the right step.
- Progress:

### W7 · Evidence
- Changed: `e2e/playwright/core-boot-deep-links-home.spec.ts` (the `✓` text assertion,
  `setup-content-pane` testid, `Do this later`, `0 of 4 proven`, `listitem` count 4 all
  change), `src/architecture/size-baseline.json` if any touched file crosses its ceiling.
- **Accept:** e2e green in both ramps; screenshots per step, light **and** dark, at
  1280×800 and 1024×640, captured from a fresh `script/onboarding-desktop.sh` profile and
  vision-reviewed before the phase is called done.
- Progress:

---

## 7. Gates inherited from the repo's working agreements

- **No false-positive verification.** Green tests are a claim, not evidence. Every phase
  with a visual surface closes on vision-reviewed screenshots from a *fresh onboarding
  profile*, in both themes. A phase is not done because its unit tests pass.
- **Local-first.** All verification runs locally via `script/onboarding-desktop.sh`;
  nothing is discovered by deploying.
- **Strangler/additive.** The registry, funnel, state and API layers are kept; only the
  presentation and the AI sub-flow are replaced. `VITE_CLAXEDO_ONBOARDING_V1` keeps
  gating the whole thing until W7 closes.
- **Illegal states unrepresentable.** `SetupLocation` union in W1; per-item credential
  state in W5 replaces the single collapsed banner.
- **Guards.** `bun run test`, `bun run test:architecture`, route-spine scanner, 800-line
  file cap (no new file should approach it — the point of the decomposition), debt
  ratchet, and `size-baseline.json` for any grown file.

---

## 8. Execution: parallelize with agents and workflows

Disjoint file ownership, so five agents can run without touching each other's files:

| Agent | Owns | Depends on |
|---|---|---|
| A · navigation | `features/onboarding/navigation*.ts`, `setup-shell-state.ts`, `home-view.ts` | — |
| B · page shell | `features/onboarding/page/**`, `app/routes/setup.tsx`, `app/entry/app.tsx`, `rail-workbench-canvas.tsx` | A's types only |
| C · AI sub-flow | `features/onboarding/ai-connect/**`, `ai-connect-surface.tsx`, `ai-connect-state.ts`, `app/dialogs/{select-provider,connect-provider}.tsx` | — |
| D · server credentials | `claxedo-server/src/credentials/{verify,discovery,sync,registry}.ts` + tests | — (W0 done; **start here, it is the live bug**) |
| E · evidence | `e2e/playwright/**`, screenshots, baselines | B, C, D |

Pipeline, not barrier: A→B and C and D run concurrently; E starts per-surface as each
lands rather than waiting for all three. W0 is strictly first and is a single agent.

---

## 9. Definition of Done

- [x] The real failure from the 2026-07-25 run is reproduced and root-caused. *(W0 — §2)*
- [x] A Codex credential with a stale access token and a valid refresh token is renewed
      instead of being called `expired`, the freshest copy of each account is the one
      imported, and the Codex probe uses a request the provider accepts.
      *(B0/B0a/B0b, W0b — live-verified)*
- [ ] A mixed verification result reports every credential's own outcome, and a batch
      containing at least one `ok` advances the step. *(B1, W5)*
- [ ] Onboarding is a route (`/setup`), not an overlay; no `absolute inset-0` onboarding
      mount remains in the workbench canvas. *(D1, D8)*
- [ ] No green/coloured step marks anywhere; the only accent in the flow is the verified
      credential chip. Native OS checkboxes are gone. *(D2)*
- [ ] Every screen after the first has a working Back; every skip states its consequence;
      no exit affordance exists on the project or AI steps. *(D3, D7)*
- [ ] At 1024×640 every step fits without the page scrolling; when a step does scroll,
      only the body does — header and action bar stay put. *(D4)*
- [ ] The scope control is a question with two radio rows and consequence copy, and is
      hidden entirely when no cloud workspace exists. *(D5)*
- [ ] Saving N credentials with one failure keeps the successes and shows a per-row
      reason and Retry. *(B1)*
- [ ] An expired scan self-heals with a `Scan again` action instead of a dead end. *(B2)*
- [ ] Two collected credentials differing only in `kind` are independently selectable and
      saveable. *(B3)*
- [ ] The two Claude Code rows are distinguishable in the UI. *(D12)*
- [ ] Locked steps are never rendered as clickable rows; they appear only as "what's
      next" on the final screen. *(D10)*
- [ ] `aria-current="step"`, focus moves to the step heading on change, Enter activates
      the primary action, and `prefers-reduced-motion` disables transitions. *(D11)*
- [ ] The API-key path is gone as a bespoke surface: setup uses the same provider list and
      per-provider connect form as the composer's connect flow, covering the full catalog
      and OAuth methods, with `scope` passed as a prop. *(S2c)*
- [ ] The rail during first-run setup shows only what is reachable — no Documents /
      Marketplace / WorkGraph entries before a workspace and credential exist — and marks
      the setup entry `aria-current="page"`. *(§3.6)*
- [ ] `DialogAIConnect`, `DialogSelectProvider` and `DialogConnectProvider` all still work,
      recomposed from the same sub-surfaces — no fork.
- [ ] `bun run test`, `bun run test:vitest`, `bun run test:architecture`, and the
      Playwright onboarding specs are green in both ramps.
- [ ] Screenshots for every step in light and dark, from a fresh onboarding profile,
      reviewed and attached under `docs/plans/evidence/`.

---

## 10. Open decisions

1. ~~**Rail during setup.**~~ Decided 2026-07-25: keep it mounted, gated to reachable
   entries only. Spec in §3.6.
2. **Web surface.** This plan is written from the desktop run. The web surface has two
   extra connect methods (provider sign-in, terminal push) that S2a lists but that have
   not been re-reviewed on a real hosted session.
3. **Re-entry.** After `Finish later`, does `/setup` resume at the first unfinished step
   or at the recap? Recommendation: recap, so the user sees what they already proved.
