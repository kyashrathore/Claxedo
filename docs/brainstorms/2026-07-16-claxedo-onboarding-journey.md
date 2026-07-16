# Claxedo Onboarding Journey — Overall Design

Status: BRAINSTORM (design-level; implementation plans to follow per step)
Date: 2026-07-16
Child plans: `docs/plans/2026-07-16-004-feat-explicit-secrets-ux-plan.md`
(Connect-AI step), `docs/plans/2026-07-07-002-feat-self-host-hosted-parity-and-channel-loop.md`
(self-host account step), `docs/plans/2026-07-12-002-feat-pi-provider-model-selection-plan.md`
(first-message model path).

## Current state (verified 2026-07-16 — the honest truth table)

There is **no onboarding machinery anywhere** — no wizard, checklist, welcome
screen, or first-run steps in app, server, or convex. What a new user actually
hits:

| Entry point | What happens today |
| --- | --- |
| Desktop/local first launch | Empty `Home` (`routes/home.tsx`): logo + "No recent projects" + one "Open project" button. Nothing else. |
| Cloud web signup | Clerk redirect (`routes/login.tsx`, `CloudAuthGate`) → dumped into the same empty Home. **No auto-created workspace, no billing gate on this path.** |
| First prompt, no AI credential | Composer model selector silently disabled ("Select model", `model-strategy.ts`). No inline coaching; user must discover `DialogSelectProvider`/`DialogConnectProvider` themselves. **There is no house model**: `SIGNED_WORKSPACE_DEFAULT_MODEL` ("big-pickle", `signed-workspace-model.ts`) is a client-side rendering placeholder only — its own comments call it a KNOWN-STALE default to skip once real models load; nothing in claxedo-server/workspace-runtime serves it, and Claxedo has no way to make AI calls on the user's behalf. A signed user who submits against the placeholder before connecting a real provider hits a model that cannot run. |
| Cloud compute setup | Raw settings forms (`sandbox-section.tsx`) — per-driver credential inputs. `DialogCreateCloudProject`/`CreateCloudWorkspace` warn "configure provider credentials in Settings" and dead-end there. Provision pipeline UI itself is good (`acquiring_sandbox → cloning → … → ready`). |
| Repo attachment | Three disjoint paths: native dir picker (desktop), raw git URL into cloud sandbox, GitHub connection in settings — never cross-linked. |
| Self-host (`claxedo deploy`) | Deploys, then prints a WARNING that the instance has **no authentication**; no signup, no admin, no in-app continuation. |
| Demo tour | `/demo` only, MSW-mocked, driven by postMessage from claxedo.com marketing iframe (`demo/tour-controller.tsx`). Not reachable/usable by a real user. |

## The activation model

**Activation = first successful agent turn on the user's own code.** Everything
in onboarding is judged by time-to-first-agent-turn (TTFAT). There is a second,
Claxedo-specific activation: **first turn that keeps running after you walk
away** (cloud workspace / hybrid session) — that's the moment Claxedo is
differentiated from stock opencode and every local-only harness.

So onboarding is two ramps, not one:

- **Ramp 1 — first turn** (minutes): project + AI credential + prompt.
- **Ramp 2 — graduate to cloud** (later, pulled not pushed): sandbox provider
  + shared credentials + first detached turn.

The BYO-compute + BYO-keys business model means Ramp 2 has real external
friction (go get a Daytona/Modal key). The design must therefore never put
Ramp 2 in front of Ramp 1.

## Design principles

1. **An explicit onboarding form, with just-in-time as the safety net**
   (owner direction 2026-07-16). First run presents a stepped setup form (see
   "The onboarding form" below). It is skippable and resumable — skipping
   never locks anything, and every step that was skipped resurfaces
   just-in-time at the moment it actually blocks (the disabled "Select model"
   composer is the canonical dead-end to eliminate; it becomes a re-entry
   into the form's AI step). The checklist card IS the resumable form. The
   banned thing is the hard gate, not the guided flow.
2. **One derived setup state, no second store.** `onboardingState()` is a typed
   selector over queries that already exist (has project? has eligible
   credential? has sandbox provider? has completed turn?) — per the one
   reactive data graph rule. Local: derived only. Hosted: persist only
   dismissals per user.
3. **A visible checklist, never a gate.** Home gains a dismissible "Get set up"
   card driven by `onboardingState()`: Project ✓ / AI connected ✗ / Cloud
   compute ✗ / First cloud task ✗. It shows progress and deep-links each step's
   CTA; it never blocks entry. Steps are a registry
   (`{id, isDone(state), cta, priority}`) so features (WorkGraph, channels,
   connections) can plug in later steps additively.
4. **Cheapest path to Ramp 1 per entry point** (golden paths below). Desktop
   target: <2 minutes, zero typing (native dir picker + credential discovery
   from the secrets plan). Web target: first turn on the free hosted model
   *before* any credential exists.
5. **The app is never empty.** Replace the bare empty Home with the checklist
   card + entry-point-appropriate primary action + a link to the hosted demo
   tour for "see what it looks like". (A real seeded example project is a
   candidate later step — see Q3 — not v1.)
6. **Every dead-end warning becomes an embedded flow.** "Configure provider
   credentials in Settings before creating cloud workspaces" → the create
   dialog embeds the provider credential form inline (the fields are already
   server-supplied), finishes the create on success.
7. **Self-host is the same product.** `claxedo deploy` must end signed
   (embedded auth + first-admin bootstrap) and print exactly one next step:
   "open <url> — setup continues in the app", where the same checklist takes
   over. Auth-less deploys with a warning are a launch blocker, not a footnote.
8. **Measure the funnel.** Emit activation events (signup → project_created →
   provider_connected → first_turn_ok → sandbox_provider_configured →
   first_cloud_turn_ok) so the GTM work has real numbers. Self-host/OSS builds:
   off by default.

## The onboarding form (owner direction, 2026-07-16)

Step count varies by surface (revised after the 2026-07-16 stress test +
owner reinstatement of remote access): **desktop = 4 steps shown, 2 asked
up front** (Project, AI active; Cloud compute and Access remotely visible
but locked until after the first turn — the full journey is on display, but
nothing Ramp-2 blocks Ramp 1); **web = 4 steps** (Project, AI, Compute,
Access remotely — the last as the immediate payoff QR moment);
**self-host = 4** (compute offers `this-server` as zero-config). Two rules
bind every step:

- **Done = proven, not saved.** Each step's done-state is a real operation —
  a test completion for the AI credential, a test clone (and push-scope
  check) for the repo, an actual provision for compute. A saved-but-broken
  key marking a step green is the funnel's biggest silent leak
  (`provider_connected` → `first_turn_ok`).
- Each step = do the thing + one compact "what this unlocks" education panel
  (a paragraph + docs link, never a forced tour).

### Step 1 — Project

| Surface | Mechanism |
| --- | --- |
| Desktop/app | Pick a local directory containing a git repo (native picker, existing `ensureLocalProject` path). Non-git dir → offer `git init` or pick again. |
| Web | **Connect GitHub (connections framework) → pick a repo → it becomes the project.** Replaces the raw git-URL field as the primary path — the connection token also makes private-repo cloning into the sandbox work, and the GitHub connection is reused later by WorkGraph/review. Escape hatches: raw **public** URL (no auth needed), and a PAT/deploy-key path for private non-GitHub hosts (a private GitLab raw URL with no credential mechanism is a dead end, not an escape hatch). Also offer "try it on an example public repo" so Step 1 is completable with zero GitHub auth. |
| Self-host | Same as web (GitHub connection), plus local-path when the operator runs it on their own box. |

**Feasibility (verified 2026-07-16): none of the web path exists yet.** The
GitHub integration is a fine-grained-PAT `verify()`-only connection
(`claxedo-connections/src/impls/github.ts`) — no repo-listing capability in
the `IntegrationImpl` interface, no connection→project wiring (cloud create
is raw `repoUrl`), and `git clone` injects no token
(`routes/workspace-git.ts` — plain `git clone`, so private repos fail).
Build path: v1 = PAT-backed repo listing + `x-access-token` clone injection
(incremental); **GitHub App** (installable per-repo, org-approvable, gives
the write/PR token story) as fast-follow — org OAuth/PAT policies otherwise
silently hide work repos from exactly the users most likely to become teams.
Done-state includes a **push-scope check**, not just clone: the first "wow"
turn is usually a branch/PR, and a read-only token kills turn #2.

Education: what a project is (worktrees, sessions live under it).

### Step 2 — AI provider

Mechanics = secrets plan `2026-07-16-004`: desktop → Discover dialog
(itemized consent over found subs) with API-key entry as a **first-class
peer, not a buried fallback** — subscription-token reuse in a third-party
harness is provider-ToS gray area, and if that path breaks post-launch the
API-key path must already be equally polished. Web → vendor OAuth where
possible, `npx claxedo connect <provider>` device-code push, API-key paste.

Stress-test corrections baked in:
- **Discovery coverage truth** (verified in `credentials/sync.ts`): Claude
  works cross-OS (keychain on darwin, `.credentials.json` file elsewhere);
  Codex cross-OS; **opencode discovery is Unix-path-only — broken on
  Windows**; **Cursor is not discovered at all** (env-var only). Copy must
  not promise Cursor discovery until it exists.
- **Credential → harness → runnable resolution.** The default harness is
  `opencode`, whose catalog credential slot is OPENAI
  (`agent-sdk-runtime/src/harness-types.ts`). A Claude-only user can
  definitively run only the `claude` harness and anthropic-backed `pi`.
  Completing this step must (a) steer the session default to a harness the
  connected credential can actually run, and (b) set a deterministic sane
  default model per provider — otherwise Step 2 shows done and the first
  turn dies.
- Discovered tokens are **re-validated with a test call**, not just found —
  a months-stale OAuth token, a key with no billing enabled, or an org rate
  cap are the common cases.

Education: **any harness works** — pi / opencode / claude-code / codex; your
subscription or API key — with honest per-credential availability shown
(which harnesses your connected credential can run), not claimed.

### Step 3 — Sandbox provider (compute)

This is the hardest wall and hides an **external sub-funnel**: most users do
not have a Daytona/Modal account — this step sends them to a third-party
signup (often with a credit card) mid-form. Design for it:

| Surface | Requirement |
| --- | --- |
| Web | **Required** — nothing can run without compute. Provider chooser with honest cost expectations and free-tier facts per driver; deep link to the driver's key page; a **resume deep-link** so the user who leaves for 20 minutes to sign up lands back on this exact step; while blocked at the wall, offer the demo tour / a replayed real session ("watch what you're setting up"). |
| Desktop | **Not in the form.** Compute lives entirely post-first-turn as the first "Go further" card (Ramp 2). The create-cloud dialogs are its just-in-time entry. |
| Self-host | Offered in-form with `this-server` as the zero-config default. |

- **Verification provision = the first workspace provision** — one provision,
  not two (it costs the user real money; say so before spending it). The
  provisioning wait itself carries the education content (teach during the
  progress pipeline).
- Failure UX: typed errors with guided fixes (bad key vs no payment method vs
  quota vs region), retry in place — not the current raw-message + Back-button
  dead end. (Existing bugs: `create-cloud-workspace.tsx` shows a false
  "Retrying automatically..." with no retry loop, and a 120s timeout navigates
  into the workspace anyway — both must die as part of this step.)

Education: **long-running processes** — cloud sessions keep running when you
close the laptop; the process pane; supervised vs autonomous execution.

### Post-form: the first-prompt moment (part of the design, not an afterthought)

The form's exit is not "configured app" — it's a composer with **repo-derived
starter tasks** (3 suggested first prompts: "explain this codebase", "fix
this TODO", a repo-specific one) and the model default already resolved.
Everything upstream otherwise delivers users to a blank box. And design the
**failed-first-turn screen** — error taxonomy (credential vs harness vs model
vs clone/context), retry with a different model — it is the highest-leverage
screen in the product; `first_turn_ok` implies `first_turn_failed` exists.

### Step 4 — Access remotely (owner reinstated, 2026-07-16)

The first stress test cut remote access as a form step (pure education).
Owner reinstated it with a better framing: it is an **action** — "open your
workspace on your phone" — and the cheapest live demo of the differentiator.
Rules that make it work:

| Surface | Behavior |
| --- | --- |
| Web | Active immediately after Step 3: a QR code (+ copyable link) for the just-provisioned workspace/session; scan → signed-in mobile view of the running session. |
| Desktop | **Visible but locked** until EITHER a cloud workspace exists OR the user flips **"Enable remote access"** — a one-time toggle where the desktop app itself enrolls this machine as a user-hosted host and keeps **ONE machine-wide relay tunnel** alive serving all local projects (single multiplexed socket, one hostId, workspaces as a registration list; per-workspace access tokens unchanged; the app is the daemon; start-at-login is the reboot story). Full feasibility review: `docs/plans/2026-07-17-001-review-remote-desktop-access-feasibility.md` — verdict: never expose the whole local app (loopback-trust showstoppers); the two-plane model (phone → hosted plane → relay → machine-as-workspace-backing) is built and safe, gated on device-login Phase A + relay deploy. The form still asks only 2 things pre-first-turn. |
| Self-host | Same as web, against the deploy URL. |

- **Proven done-state like every other step:** the QR link carries a marker;
  the step turns green when the session is opened on a second device — not
  viewed/dismissed.
- Education attached to this step: WorkGraph and
  deploy-on-your-own-infra remain "Go further" cards; long-running-process
  education stays on Step 3.
- **New open question Q9:** mobile-web readiness — the app must be verified
  usable on a phone viewport before this step ships; if composing is rough,
  v1 scope is honest "monitor + reply", not full control.

### Form rules

- Progress derives from `onboardingState()` — the form has no state of its
  own; reopening it shows current truth (a step completed via Settings shows
  done in the form).
- Every step has Skip (except web steps 1–3, which are factually required to
  do anything — but even there the form can be dismissed to browse the app).
- **Just-in-time re-entry opens the step-local dialog directly** (Discover /
  Connect / provider setup), not the whole form — the form and checklist
  merely re-derive afterward. Reopening a stepped form from a disabled
  composer is the wrong weight.
- Completing the form (or dismissing it) collapses it into the Home checklist
  card; finishing all steps morphs the card into "Go further" education cards
  (cloud compute/Ramp 2, remote access, WorkGraph, harness choice, self-host)
  that are individually dismissible.
- Hidden step made explicit: desktop → cloud requires a **hosted sign-in**
  the desktop flow never needed; the compute "Go further" card must surface
  it as its first action, or the checklist lies about what one click does.

## Golden paths per entry point

### Desktop / local (primary OSS funnel at launch)

1. Launch → onboarding form, exactly TWO steps: Step 1 native dir pick,
   Step 2 Discover dialog (found subs re-validated, itemized consent — zero
   typing; API-key entry equally prominent).
2. Form completes → composer with harness+model resolved to the connected
   credential and repo-derived starter prompts → first turn.
3. If the user skipped or dismissed early: the composer's dead disabled
   selector becomes an inline "Connect an AI provider to send" that opens the
   Discover/Connect dialog directly; checklist card carries the open steps.
4. First turn succeeds → the form's locked steps 3–4 activate (cloud compute
   [hosted sign-in surfaced first], then Access remotely with its QR moment)
   and the checklist adds "Go further" education cards (WorkGraph, harnesses,
   self-host).

TTFAT: ~2 minutes, zero secrets typed.

### Cloud web

Web Ramp 1 has TWO walls, not one: Claxedo cannot make AI calls itself (no
house model — BYO keys) and cannot run code itself (BYO compute). Launch is
free and strictly BYO (Q1 resolved), so both walls are permanent parts of the
web funnel — the job of onboarding is to make them two guided, verifiable
steps rather than dead ends.

1. Clerk signup → onboarding form, all three walls as guided steps: Step 1
   connect GitHub → pick repo → project; Step 2 connect AI (OAuth /
   `claxedo connect` / API key); Step 3 sandbox provider (required,
   provision-verified). The composer placeholder-model path is fenced so a
   user can never submit against a model that cannot run.
2. Form completion flows directly into provisioning the first cloud workspace
   from the selected repo → first turn; Step 4 then offers the QR — open the
   running session on your phone (proven by the second-device open).
3. Web onboarding copy stays honest — free product, your keys, your compute —
   and offers "fastest start: desktop app / CLI" beside the form.

### Self-host

1. `claxedo deploy` → deploy ends with embedded-auth enabled + first-admin
   device-code claim (no auth-less warning path).
2. Open URL → sign in → same onboarding form; the AI step defaults to
   `claxedo connect --remote <url>` (creds pushed from the user's machine,
   never typed into the server box); compute step offers `this-server` as the
   zero-config option.

### Marketing → product bridge

`/demo` tour stays marketing-owned, but the last tour step's CTA and the
in-app empty state cross-link ("try it for real" ↔ "see the tour"). No MSW
inside the real app.

## Step registry (initial contents)

| Step | Done-when | Surfaces | Owner plan |
| --- | --- | --- | --- |
| Account | signed in (hosted/self-host) / n.a. local | login route, deploy CLI | self-host parity plan |
| Project (form step 1) | ≥1 project | form; dir picker (desktop) / GitHub connection → repo pick (web, via connections framework) | onboarding-v1 plan (new) |
| Connect AI (form step 2) | ≥1 eligible credential | form; composer inline CTA re-entry; Discover dialog / OAuth / `claxedo connect` | secrets plan 2026-07-16-004 |
| Cloud compute (web form step 3; desktop post-first-turn card) | ≥1 sandbox provider provision-verified | form (web); "Go further" card + create-cloud dialogs (desktop) | onboarding-v1 plan (new) |
| Hosted sign-in (desktop→cloud) | signed in from desktop | compute step unlock, first action | onboarding-v1 plan (new) |
| Access remotely (form step 4) | session opened on a 2nd device (QR marker) — desktop: locked until a cloud workspace exists | form step 4; QR panel | onboarding-v1 plan (new) |
| First turn | ≥1 completed assistant turn | composer | pi-provider-model-selection plan |
| First cloud task | ≥1 turn in a cloud workspace | checklist / "Go further" | onboarding-v1 plan (new) |
| Education cards | dismissed individually | post-form Home: long-running processes, WorkGraph, any-harness, self-host deploy | onboarding-v1 plan (new) |
| Later (pluggable) | connections, channels, team invite, WorkGraph source | respective features | respective plans |

## Stress-test findings (adversarial review + code verification, 2026-07-16)

Findings already folded into the form spec above: 2-step desktop form;
done=proven verification per step; web Step 1 feasibility gap (PAT-v1 →
GitHub App); harness↔credential resolution; discovery coverage truth;
compute sub-funnel + merged provision; first-prompt moment +
failed-first-turn screen; JIT opens dialogs not the form; remote access
demoted to a card; hosted sign-in made explicit. The rest:

### Structural gap: provider/compute credentials have no tenant partition

Verified: `claxedo_provider_credential` has **no org/user column**
(`storage/provider-credential.sql.ts`) — AI and sandbox credentials are
per-control-plane-instance, while connections DO have team/personal scoping
(`connections-host/org-membership.ts`). Consequences: the **invited team
member #2** story (use the team's Daytona/AI creds, don't re-run the form) is
unbuildable for provider creds today, and hosted multi-org tenancy of these
secrets needs verification before any team onboarding ships. Feeds the
secrets plan's scope model (owner partition alongside `local|shared`) and the
connection-scoping plan's 3b phase.

### Segment backlog (ordered; each is a user type the v1 form ignores)

1. **CLI/TUI-first dev** — the most on-brand missing segment for an opencode
   fork launching on HN: `brew install` → never opens Electron. Needs a
   terminal first-run (auth, connect, first turn) — even a minimal
   `claxedo connect` + docs path beats nothing.
2. **Existing opencode user** — highest-intent migrator; Discover should
   import their `auth.json`/config wholesale as an explicit, celebrated
   "import from opencode" first screen (Cursor's VS-Code-import pattern).
3. **No-AI-key visitor** — curious HN reader with no subscription/key. Design
   the Step 2 dead end: provider signup guidance with cost expectations +
   demo tour as consolation activation; otherwise they churn silently.
4. **Second machine / returning user** — local-scope creds don't follow;
   machine #2 must explain "your cloud workspaces are here; keys live on
   your other machine — re-run discovery," not silently re-run the form.
5. **Invited member #2** — blocked on the tenancy gap above.
6. **Windows user** — opencode discovery path broken, `npx` in PowerShell,
   SmartScreen; the app SHIPS on Windows (electron-builder nsis target), so
   Step 2 claims must be tested there, not assumed.
7. **GitLab/other-git private repo** — PAT/deploy-key path (folded into
   Step 1 spec).
8. **Mobile-web signup** — nothing is completable from a phone; needs an
   "email me the desktop link" handoff or the signup is wasted.

### Install/download is out of frame

The desktop golden path starts at "Launch," but the primary OSS funnel starts
at a README/HN comment: download, Gatekeeper/SmartScreen (are builds
signed/notarized?), first-open permissions. Own it here or link the doc that
owns it — the top of the primary funnel is currently unowned.

### Lifecycle re-engagement

With two mandatory external-account walls on web, a stall-triggered email
("you're one step from your first agent task") off the funnel events is where
a large fraction of web activations will actually complete. Post-launch
candidate, but the events must be designed for it now.

### Competitor patterns deliberately NOT adopted

Trial credits/free requests (no house model — would be a dark pattern here);
"one sign-in and you're running" magic (impossible with two external
accounts; honest copy is the moat); hosted instant playground (nearest legal
substitute = demo tour + replayed sessions, which is why those are promoted
to the compute wall instead).

## Open product questions (with recommendations)

- **Q1 — RESOLVED (owner, 2026-07-16): launch is FREE, strictly BYO AI keys +
  BYO compute. No subsidized trial of any kind** (there is also no house model
  to subsidize — "big-pickle" is a client-side placeholder with no serving
  path). Consequence: the web funnel is honestly 3 steps (connect AI → connect
  compute → first turn), the checklist carries it, and marketing leads with
  desktop/CLI as the fastest start. No billing, paywall, or plan gating
  appears anywhere in onboarding.
- **Q2 — RETIRED (false premise).** Earlier draft assumed a free hosted model;
  none exists. Replacement work item: **fence the placeholder** — the composer
  currently lets a signed user compose/submit against "big-pickle" before real
  models load, which is a submit-into-a-wall path; the blocked-composer
  intervention (principle 1) must treat placeholder-only as "no model" and
  route to Connect AI.
- **Q3 — Seeded example project.** A real (non-MSW) example session showing a
  finished agent task, auto-present on first run. **Recommend defer** — the
  checklist + fast Ramp 1 likely suffices; revisit with funnel data.
- **Q4 — Checklist persistence.** **Recommend**: derived state everywhere;
  dismissals in existing persist layer locally (`Persist.global`) and per-user
  KV on hosted. No new tables.
- **Q5 — Primary launch funnel.** GTM research says the real audience is
  ~500–700K devs reached via OSS/HN — **recommend desktop/local as the
  polished-first path**, web trial second, self-host third (but signed deploy
  is a hard launch gate regardless).
- **Q6 — Telemetry contradiction (needs owner call).** Funnel events are
  "off by default for OSS builds" — but Q5 makes desktop/OSS the primary
  funnel, so as written we launch blind exactly where the numbers matter.
  Options: first-run opt-in prompt (transparent, fork-trust-compatible) vs
  anonymous aggregate counts vs accept flying blind. **Recommend the explicit
  opt-in prompt** — it's honest, and even 20% opt-in beats zero data.
- **Q7 — GitHub App timing.** v1 = PAT-backed repo listing + tokened clone
  (small, incremental); GitHub App (org-approvable, per-repo install, write
  token for PRs) as fast-follow. **Recommend committing to the App before
  team GTM** — org policies hide work repos from PAT/OAuth users, which is
  exactly the future-paying segment.
- **Q8 — Provider-credential tenancy.** The no-org-column gap (stress-test
  findings) must be resolved — either verified as fine (per-org control-plane
  instances) or fixed with an owner partition — **before invited-member
  onboarding or any team-scope credential UX ships.**
- **Q9 — Mobile-web readiness for Step 4.** "Open your workspace on your
  phone" requires the web app to be usable at a phone viewport. Verify before
  the step ships; if composing is rough, scope v1 honestly to "monitor +
  reply" and say so in the step copy.
- **Q10 — Session placement for remote-enabled projects.** Desktop-local
  sessions (`host: "local"`) live only in local SQLite and are invisible from
  the phone. Decide: place new sessions in remote-enabled projects as
  user-hosted (visible both surfaces) vs accept "phone sees workspaces +
  sessions started while remote-enabled" in v1. (Review doc
  `2026-07-17-001`.)

## Sequencing

1. **Now**: secrets plan Phases 1–3 (already planned) — they are the Connect-AI
   step's machinery and are independent of everything above.
2. **Onboarding v1** (new plan — unblocked, all questions resolved):
   `onboardingState()` selector + step registry + the 4-step onboarding form
   (project / AI / compute / remote-access, per-surface variants) + Home
   checklist card as the form's collapsed/resumable state + composer inline
   connect CTA + embedded provider form in cloud-create dialogs + big-pickle
   placeholder fence + education panels and post-form "Go further" cards.
   Web project step depends on NEW connections-framework capability (repo
   listing on the PAT connection + `x-access-token` clone injection — neither
   exists today; verified). Also in scope: harness-default steering +
   deterministic model default, repo-derived starter prompts,
   failed-first-turn screen, provision-failure typed errors (incl. killing
   the false "Retrying automatically" copy and the 120s navigate-anyway
   timeout in `create-cloud-workspace.tsx`). Secrets plan Phase 4's
   "onboarding step" lands *inside* this framework instead of standalone.
3. **Self-host signed deploy** (existing parity plan) — account step.
4. ~~Web trial~~ — cut (Q1 resolved: free launch, strictly BYO; nothing to
   subsidize).
5. **Funnel instrumentation** — with v1, not after.

## Non-goals

- No hard gates: the onboarding form is skippable/dismissible everywhere it
  factually can be, resumable always, and never a blocking modal wall. No
  forced tour.
- No MSW/demo machinery in the real app.
- No new state store or onboarding database tables (dismissals ride existing
  persistence).
- Billing/plan gating UX — launch is free (owner decision 2026-07-16); no
  paywall, plan, or checkout anywhere in onboarding. If paid seats arrive
  later, they must not be retrofitted into the signup→first-turn path.
