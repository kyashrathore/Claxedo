---
title: "Claxedo Onboarding — Product Features, UX, and Architecture"
type: feat
date: 2026-07-16
status: active
audience: product + engineering (readable companion)
companion_of: docs/brainstorms/2026-07-16-claxedo-onboarding-journey.md
related: docs/plans/2026-07-16-004-feat-explicit-secrets-ux-plan.md
---

# Claxedo Onboarding — Product Features, UX, and Architecture

This is the readable companion to the
[onboarding journey brainstorm](../brainstorms/2026-07-16-claxedo-onboarding-journey.md)
(which owns the activation model, stress-test findings, and open questions)
and the future onboarding-v1 implementation plan (which will own units and
gates). It answers: **what does a new user get, where does each piece live in
the app, what does it look like, why does it exist, and how does it work.**

## The idea in one paragraph

Claxedo launches free with strictly bring-your-own AI keys and compute, so a
new user has real setup to do — and today the app gives them an empty screen,
a silently disabled composer, and settings forms that dead-end. Onboarding v1
replaces that with a **short setup form on the Home surface** (two steps on
desktop, three on web), where every checkmark means something **actually
worked** — a real API call completed, a real clone succeeded, a real sandbox
provisioned — and every skipped step waits quietly in a checklist and
reappears exactly where it blocks. The form ends not at "configured" but at a
**composer pre-loaded with starter prompts** and a model that is guaranteed
to run. Everything cloud-related stays out of the way until after the first
successful local turn, because the first turn is the product's hello.

---

## Part 1 — What the user gets

### 1. A Home that starts you instead of staring at you

**What:** On first launch, the Home surface shows a setup card in place of
today's bare "No recent projects" empty state. Four steps are always visible
— *Open a project / Pick a repository*, *Connect your AI*, *Add compute*,
*Access remotely* — but only what's actionable is asked: on desktop, steps
1–2 are active and steps 3–4 render **locked with their unlock condition**
("after your first task") so the full journey is on display without anything
cloud-related blocking the first prompt; on web all four run in order. Each
step row has a title, a one-line "what this unlocks" note, and a state:
open, in progress, locked, or a **proven** checkmark.

**Where & look:** The Home route (`routes/home.tsx`), rendered in the app's
hairline visual language — a quiet, fixed-width card in the content area, not
a modal and not a separate route. The step list sits left; the active step's
content renders inline to the right (the pickers and dialogs described below
render *inside* the card, not as stacked popups). A small "skip for now"
text action sits under each skippable step; dismissing the whole card is
always possible and collapses it to the checklist (feature 9). The card never
blocks the rail, tab bar, or navigation — a user can ignore it entirely and
browse.

**Why:** The empty Home is the single worst screen in the current product —
it gives a brand-new user one button and no story, and every prerequisite
after that button is discovered by hitting a wall.

**How (short):** The card is a pure render of the derived
`onboardingState()` (Part 2.1) over a step registry. It has no state of its
own; a step completed from Settings shows done here instantly.

### 2. Checkmarks that never lie

**What:** A step turns green only when a real operation proved it: the AI
credential completed a test call, the repository actually cloned (and push
access was checked), the sandbox actually provisioned. A key that saved but
can't work — no billing, org rate cap, stale OAuth token — shows as
**"connected, not working"** with the provider's error and a fix action,
instead of a green check followed by a mysteriously dead first turn.

**Where & look:** Inside each step row: a spinner during verification, then
either the check or an amber warning state with one line of diagnosis
("Anthropic key valid but has no billing enabled → open billing page").

**Why:** The largest silent funnel leak is `provider_connected` →
`first_turn_ok`. A saved-but-broken credential is the common case, not the
edge case.

**How (short):** Each step's done-state is a verification operation (Part
2.3), not a row-exists query.

### 3. Discover your AI — see everything before anything leaves your machine

**What (desktop):** The *Connect your AI* step scans this machine for
existing AI setups — Claude Code, Codex CLI, opencode — and lists what it
found: provider, masked account, where it was found ("macOS Keychain",
`~/.codex/auth.json`), and freshness. The user unchecks anything they don't
want, picks where it may be used ("this machine only" / "my cloud
workspaces"), and saves. Typing an API key is an equally prominent path on
the same screen, never a buried fallback. Found tokens are re-validated with
a test call before the checkmark.

**Where & look:** Embedded in the setup card's step 2 (desktop); also
reachable forever from Settings → Connections ("Detect on this machine") and
from the composer's connect action. A consent line states plainly where the
credential will run — including that cloud use of subscription tokens is the
user's call.

**Why:** The current pipeline harvests silently — bad trust optics for an
OSS fork and impossible to reason about. Discovery stays automatic; *upload*
becomes explicit and itemized. (Mechanics owned by the
[secrets plan](./2026-07-16-004-feat-explicit-secrets-ux-plan.md).)

**Honesty note:** v1 discovers Claude (cross-OS) and Codex (cross-OS);
opencode on macOS/Linux. Cursor is not discoverable yet and the UI must not
claim it.

### 4. Connect from the web without pasting a secret

**What (web):** The *Connect your AI* step shows provider cards. Where the
vendor supports browser OAuth, it's one click. Otherwise the card shows a
copyable command — `npx claxedo connect claude` — the user runs it in their
terminal, approves a device code, and the card flips to **Connected ✓** by
itself. The secret travels CLI → server, never through the browser or
clipboard. Plain API-key paste remains for simple keys.

**Where & look:** Setup card step 2 on web; the same cards appear in
Settings → Connections. The command is monospaced with a copy button and a
live "waiting for your terminal…" state.

**Why:** A pure web product has no local machine to scan; clipboard-relay of
OAuth bundles leaks into clipboard managers and goes stale. Device-code push
reuses auth machinery that already exists.

### 5. Pick a repository, get a project (web)

**What (web):** Step 1 connects GitHub and shows a searchable list of the
user's repositories; picking one creates the project and later clones it
into the sandbox using the connection's token — private repos included. A
"try it on an example public repo" option makes the step completable with
zero GitHub auth, and a raw-URL path covers public repos on any host (with a
PAT/deploy-key path for private non-GitHub hosts).

**Where & look:** Setup card step 1 on web: a "Connect GitHub" button (v1:
fine-grained PAT with a deep link that pre-fills the needed scopes and a
two-line explanation of why those scopes), then a filterable repo list with
owner avatars. After pick: repo name shown with a "read ✓ / write ✓" badge
pair from the access check.

**Why:** Today's cloud-project dialog takes a raw URL and cannot clone
private repos at all (no token injection). Repo-pick is also the connection
Claxedo reuses later for WorkGraph and review — one connect, several payoffs.
The write-access badge exists because a read-only token kills the second turn
("open a PR"), which is where retention starts.

### 6. Compute setup that respects it's the hardest step (web)

**What (web):** Step 3 shows sandbox provider cards (Daytona, Modal, …) each
with honest facts: what it costs, whether a free tier exists, what you need
(account + API key). Picking one deep-links to the provider's key page,
takes the pasted key, and verifies by **provisioning your actual first
workspace** — one provision, not a test-then-real double spend, with a plain
note that this runs on the user's account. While provisioning, the progress
pipeline doubles as the education moment: this is the machine your agents
keep running on after you close the laptop. If the user leaves mid-step to
create a provider account, a resume link returns them to exactly this step.

**Where & look:** Setup card step 3 on web. Failures render as typed,
fixable errors — "key valid but account has no payment method → link" — with
retry in place, replacing today's raw-message + Back dead end.

**Why:** This step sends users to a third-party signup mid-flow; it will be
where web activation dies unless it's treated as a sub-funnel with resume,
cost honesty, and something to watch (the demo tour is offered at this wall).

**On desktop:** this step does not exist in the form at all. Compute appears
after the first successful local turn as the first "Go further" card
(feature 10) — cloud before the first prompt is backwards.

### 7. A first prompt that's already half-written

**What:** When the form completes, the user lands in a session composer that
is ready: harness and model are pre-resolved to something their credential
can actually run (shown as a small badge, changeable), and above the
composer sit three **starter prompts derived from the repo** — "Explain how
this codebase is organized", "Find and fix a TODO", and one repo-specific
suggestion. One click inserts it; Enter sends.

**Where & look:** The normal session view — no special mode. Starter prompts
are quiet chips above the composer that appear only for a project with no
completed turns and vanish forever after the first send.

**Why:** Everything upstream otherwise delivers the user to a blank box in
an unfamiliar product. This is the cheapest high-leverage screen in the
funnel. The harness badge exists because "any harness" is only true per
credential — a Claude-only user gets `claude` (or anthropic-`pi`), never a
default that can't run.

### 8. When the first turn fails, the app knows why

**What:** A failed first turn renders a diagnosis card, not a raw error:
credential problem ("Anthropic returned 401 — reconnect"), harness problem,
model problem ("try a different model" with a one-click switch), or
workspace problem — each with one action. The draft prompt is preserved.

**Where & look:** In the session timeline where the error occurred, styled
as the app's standard attention card.

**Why:** `first_turn_ok` implies `first_turn_failed` exists; today that user
gets an opaque error and leaves. This is the highest-leverage recovery
screen in the product.

### 9. No dead ends, and a checklist that remembers

**What:** Every current dead end becomes a live path: the disabled composer
model selector becomes "Connect an AI provider to send" and opens the
connect surface directly; the cloud-create dialogs embed the provider setup
inline instead of pointing at Settings. Skipped steps live in a compact
**setup checklist card** on Home — provable states, one CTA each,
dismissible — which is the collapsed form of the setup card and the way back
into it.

**Where & look:** Checklist: a slim card above the project-grouped stream
cards on Home. Interventions: inline, at the exact control that was
previously disabled or dead.

**Why:** The form is one pass; the checklist plus just-in-time re-entry is
what makes skipping safe instead of a trap.

### 10. Step 4 — your agent, on your phone

**What:** The last step shows a **QR code** (and a copyable link) for a
running workspace session: scan it, sign in on the phone, and watch the
agent work from anywhere — the live demonstration of the product's core
promise, sessions that keep running after the laptop closes. The step turns
green only when the session is actually **opened on a second device**, like
every other checkmark.

**Where & look:** Setup card step 4. On web it activates the moment the
first cloud workspace is running (right after step 3's provision — the
workspace just came alive; the QR is its victory lap). On desktop the step
is visible from the start and unlocks two ways: a cloud workspace, or a
one-time **"Enable remote access"** toggle — the desktop app enrolls this
machine as a user-hosted host (app-owned key, existing challenge/sign
protocol) and keeps **one machine-wide relay tunnel** alive itself, serving
all local projects over a single multiplexed socket (2.11), with
start-at-login as the reboot story; a **Devices** list in Settings shows
enrolled machines with last-seen and revoke. The panel is a QR, one sentence, and the link.
The entire local app is never exposed — the phone reaches this machine only
as workspace backings through the hosted plane's auth (feasibility review:
`2026-07-17-001-review-remote-desktop-access-feasibility.md`; gated on
device-login Phase A + relay deploy).

**Why:** Remote access as *education* landed flat pre-first-turn (the first
stress test cut it); as an *action* it's the cheapest wow in the funnel and
the moment Ramp 2 stops being abstract.

**Honesty note (open question Q9):** this promises the web app works at a
phone viewport. Verify before shipping; if mobile composing is rough, the
step copy scopes itself to "monitor and reply from your phone."

### 11. "Go further" — the second ramp, pulled not pushed

**What:** After the first successful turn, the checklist morphs: the locked
steps 3–4 activate (compute first — on desktop starting with the hosted
sign-in it genuinely requires — then the phone QR), and up to three
dismissible education cards appear: **WorkGraph** (organize agent work into
streams), **Any harness** (what your credential unlocks), and **Deploy on
your own infra** (`claxedo deploy` — same product, your box). Each is a
paragraph, one action, and a docs link.

**Where & look:** Same Home slot as the checklist; quiet fixed-size cards
matching the stream-card language. Individually dismissible, never
re-spawned once dismissed.

**Why:** Ramp 2 (detached cloud sessions) is the differentiator, but it
sells itself best right after the user has felt Ramp 1 — and its education
content lands better than any pre-first-turn tutorial could.

### 12. A Connections page that tells the whole truth

**What:** Settings → Connections lists every AI credential and integration
with: provider, type (subscription OAuth / API key), **scope** ("this
machine" / "cloud workspaces"), **health** (working / expires soon / broken,
from real verification), last used, and actions — reconnect, change scope,
remove (with consequences: "2 cloud workspaces will lose Claude access").

**Why & how:** Owned by the secrets plan; listed here because onboarding's
step 2/3 surfaces and this page are the same components rendered in two
places.

### 13. Self-host that greets you signed-in

**What:** `claxedo deploy` ends with authentication on and a first-admin
claim step (device code in the terminal), then prints one next step: open
the URL — where the same setup form continues, with the AI step defaulting
to `claxedo connect --remote <url>` (credentials pushed from the operator's
machine, never typed into the server) and compute offering `this-server` as
the zero-config runner.

**Why:** Today's deploy prints a warning that anyone with the URL can use
the instance. Self-host is the same product; its first minute must be too.

---

## Part 2 — How it works

### 2.1 One derived setup state

`onboardingState()` is a typed selector over queries the app already holds —
no new store, no onboarding tables:

| Signal | Source (exists today) |
| --- | --- |
| has project | project list / recents |
| AI credential + health | `GET /api/claxedo/credentials` (gains `scope`/`health`/`last_used_at` per secrets plan) |
| runnable harnesses | credential providers × harness catalog (2.4) |
| sandbox provider configured | workspace-providers endpoint |
| first turn / first cloud turn | session/turn queries |
| hosted sign-in (desktop) | auth session state |
| opened on a second device | second-device open marker (2.3) |

Only **dismissals** persist (local: `Persist.global`; hosted: per-user KV).
The state is per-surface-aware: machine-local credentials count on this
machine only, `shared`-scope credentials count everywhere — so machine #2
correctly shows "keys live on your other machine — re-run discovery" instead
of pretending the step is done or undone.

A **step registry** — `{ id, appliesTo(surface), isDone(state), verify(),
cta, education }` — drives the setup card, the checklist, and the "Go
further" cards from one list; later features (channels, team invite) add
entries without touching the framework.

### 2.2 Where each UI piece mounts

| Piece | Mount point |
| --- | --- |
| Setup card / checklist / Go-further cards | Home route content, above stream cards |
| Discover dialog content | shared component: setup card step, Settings → Connections, composer JIT |
| Provider cards + `claxedo connect` poller | shared: setup card step (web), Settings |
| Repo picker | setup card step 1 (web); later reused by cloud-create dialog |
| Compute provider setup | shared: setup card step 3 (web), embedded in `DialogCreateCloudProject` / `DialogCreateCloudWorkspace` |
| Starter prompts | composer region, gated on `project has zero completed turns` |
| Failed-first-turn card | session timeline error slot |
| Phone QR panel | setup card step 4 (web: post-provision; desktop: unlocked by first cloud workspace) |

The just-in-time rule: interventions open the **step-local component**
directly (dialog-weight), never the whole form; the form re-derives
afterward.

### 2.3 Verification operations (what "proven" means)

| Step | Operation | Surface |
| --- | --- | --- |
| AI credential | `POST /api/claxedo/credentials/:id/verify` — server-side minimal completion against the provider (1-token call); returns typed result: ok / auth_failed / no_billing / rate_capped / expired. NEW endpoint. | claxedo-server |
| Repository | `git ls-remote` with the connection token (read) + a permissions probe via the GitHub API for push scope → "read ✓ / write ✓/✗" | claxedo-server |
| Compute | the existing provision pipeline, run once as the real first workspace; SSE events already exist | existing |
| First turn | the turn itself; failure classified by the error taxonomy (2.6) | session runtime |
| Access remotely | QR link carries a short-lived marker param; when the session route is opened signed-in on a device with a different client id, the server records `second_device_open` for the workspace — the step's done-signal. No new auth surface: the link is the normal session URL; sign-in on the phone is the ordinary hosted login. | claxedo-server |

Verification results are cached briefly and feed the same `health` field the
Connections page shows — one truth for both surfaces.

### 2.4 Credential → harness → model resolution

From the harness catalog (`agent-sdk-runtime/src/harness-types.ts` auth
slots, plus `pi-credentials.ts` provider mapping), a pure function maps the
set of verified credentials to runnable harnesses:

- anthropic → `claude` (acp/native), `pi` (anthropic models)
- openai/codex → `codex`, `opencode`, `pi` (openai/codex models)
- cursor key → `cursor`

Completing the AI step sets the session default harness to the best runnable
one and a deterministic default model per provider (owned by the
pi-provider-model-selection plan's tables). The composer badge renders this
resolution; the "any harness" education panel renders its honest inverse
(which harnesses this credential unlocks).

### 2.5 Web repo picker (v1 = PAT, App = fast-follow)

v1 additions to the connections framework and server (none exist today —
verified):

1. `listRepositories` capability on the `code-host` integration interface;
   GitHub impl calls `GET /user/repos` with the stored fine-grained PAT.
2. Cloud project creation accepts `{ connectionId, repo }` in addition to
   raw `repoUrl`; the server resolves the token at clone time and injects it
   (`https://x-access-token:<token>@github.com/...` or askpass) — the token
   never appears in stored config, env vars, or logs.
3. Access probe for the read/write badges.

GitHub App (installable per-repo, org-approvable, installation tokens for
PRs) replaces the PAT path as fast-follow — decision Q7 in the brainstorm.

### 2.6 First-turn error taxonomy

Turn failures classify into: `credential` (provider 401/403/429/billing),
`harness` (binary missing / harness start failure), `model` (unknown model /
provider default stale — includes the fenced "big-pickle" placeholder,
which resolution 2.4 makes unreachable), `workspace` (clone/context/size).
Each class maps to one recovery action on the failure card. The
classification lives server-side next to where turn errors already surface,
so CLI and channels get the same taxonomy later.

### 2.7 Starter prompts

v1 is deliberately non-AI (no credential has necessarily completed a turn
yet, and determinism beats cleverness here): two static templates plus one
repo-derived suggestion from cheap signals the server already has (README
title/first heading, dominant language, a TODO/FIXME grep capped at first
match). Generated at project-open, cached on the project. An AI-generated
upgrade can ride later behind the same interface.

### 2.8 Funnel events

`signup`, `setup_form_shown/dismissed`, `step_done{step, surface}`,
`step_verify_failed{step, class}`, `provider_connected`, `first_turn_ok`,
`first_turn_failed{class}`, `sandbox_provider_configured`,
`first_cloud_turn_ok`, `gofurther_card_clicked/dismissed{card}`. Hosted:
on. OSS/self-host builds: **off by default pending Q6** (recommended:
explicit first-run opt-in prompt); events are designed now either way so
stall-triggered lifecycle email can consume them later.

### 2.9 Feature → mechanism map

| Feature (Part 1) | Mechanism (Part 2) | Owner plan |
| --- | --- | --- |
| 1 Setup card | 2.1 selector + registry, 2.2 mounts | onboarding-v1 |
| 2 Proven checkmarks | 2.3 verification ops | onboarding-v1 (+ secrets plan for credential verify surface) |
| 3 Discover your AI | secrets plan discover/save-discovered | secrets `2026-07-16-004` |
| 4 `claxedo connect` | secrets plan Phase 3 (device-code push) | secrets `2026-07-16-004` |
| 5 Repo picker | 2.5 listRepositories + tokened clone | onboarding-v1 (connections framework) |
| 6 Compute sub-funnel | 2.3 provision-as-first-workspace + typed errors | onboarding-v1 |
| 7 First-prompt moment | 2.4 resolution + 2.7 starter prompts | onboarding-v1 (+ pi model-selection plan) |
| 8 Failed-first-turn | 2.6 taxonomy | onboarding-v1 |
| 9 Dead ends → paths | 2.2 JIT rule | onboarding-v1 |
| 10 Phone QR (step 4) | 2.3 second-device open marker; Q9 mobile viewport gate | onboarding-v1 |
| 11 Go further | 2.1 registry (post-first-turn entries) | onboarding-v1 |
| 12 Connections page | secrets plan Phase 2 | secrets `2026-07-16-004` |
| 13 Signed self-host | embedded auth + device claim | self-host parity `2026-07-07-002` |

### 2.10 First-run flows

```mermaid
flowchart TD
  subgraph Desktop
    A[Launch] --> B[Setup card: 2 steps]
    B --> C[Step 1: native dir pick]
    C --> D[Step 2: Discover → consent → test call]
    D -->|proven| E[Composer: harness+model resolved,\nstarter prompts]
    E --> F[First turn ok]
    F --> G[Steps 3-4 unlock:\ncloud compute (sign-in first) → phone QR]
    G --> I[Go further cards:\nWorkGraph, harnesses, self-host]
    D -->|skip/dismiss| H[Checklist card]
    H -->|composer CTA| D
  end
```

```mermaid
flowchart TD
  subgraph Web
    A[Clerk signup] --> B[Setup card: 3 steps]
    B --> C[Step 1: GitHub connect → repo pick\n(or example public repo)]
    C --> D[Step 2: OAuth / npx claxedo connect / key\n→ test call]
    D --> E[Step 3: provider card → key →\nPROVISION = first workspace]
    E -->|watch demo at the wall,\nresume link if user leaves| E
    E --> F[Step 4: QR → open on phone\n(proven: second-device open)]
    F --> G[Composer + starter prompts]
    G --> H[First turn ok]
  end
```

### 2.11 Remote access — one tunnel per machine

The step-4 desktop unlock ("Enable remote access") enrolls the machine
once and opens **one** relay tunnel for the whole machine — not one per
workspace (full review: `2026-07-17-001-review-remote-desktop-access-
feasibility.md`):

- One app-owned host key / `hostId` per machine; the embedded
  claxedo-server dials the existing `startUserHostedWorkspaceTunnel`
  machinery and registers `{ hostId, workspaceIds: [...all local
  projects] }`. Opening a new project later is a registration update on
  the same socket, never a new connection or process.
- The tunnel protocol multiplexes concurrent HTTP + streams by
  `request_id`/`channel_id` with the workspace id on each envelope; the
  relay routes by `hostId` and checks the workspace against the registered
  list; browser-side access tokens stay minted per workspace — machine-wide
  is only the transport pipe, authorization scope is unchanged.
- The desktop app is the daemon (start-at-login = reboot survival); a
  Settings **Devices** list shows enrolled machines (last-seen, revoke via
  the existing runtime-access-token revocation).
- The local control plane's own surface is never exposed — the phone
  reaches this machine only as workspace backings through hosted auth.
- Gates: device-login Phase A + relay/hosted deploy; per-tunnel caps
  (32 in-flight HTTP / 16 WS channels) are machine-wide and
  relay-config-tunable.

### 2.12 What this doc does not own

Activation model, stress-test findings, segment backlog, and open questions
Q6–Q8 → the brainstorm. Secrets mechanics (discovery stash, consent
provenance, scope column, device-code push) → secrets plan. Signed deploy →
self-host parity plan. Model-default tables → pi-provider-model-selection
plan. Unit-level DoD and verification gates → the onboarding-v1
implementation plan, to be written against this doc.
