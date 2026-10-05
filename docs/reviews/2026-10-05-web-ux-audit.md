# Web UX audit and fix log — 2026-10-05

The owner's statements, every bug found (live on staging, by review rounds 1–2, by lanes), and each item's status. Binding UX principles are in `docs/reviews/2026-10-05-web-ux-principles.md`. Review findings tables: `2026-10-05-review-r1-findings.md`, `2026-10-05-review-r2-app.md`, `2026-10-05-review-r2-server.md`.


Status keys: OPEN · IN-PROGRESS (lane) · FIXED (commit) · VERIFIED (live on staging) · DECIDED (ruling, no code)
Detailed evidence per item: `notes.md` beside this file. Batches: A = settings/web gaps & polish, B = functional bugs,
C = telemetry, D = loading/perf. Each batch: implement → adversarial review → fix review findings → deploy → live re-check.

## Owner rulings (DECIDED)
- R1 Restore ChatGPT-plan (Codex OAuth) sign-in on hosted. (DONE earlier: Lane O, on dev.)
- R2 Cloud workspace name is REQUIRED; no auto-naming. (DONE: dev fbfbb84726.)
- R3 One "where" picker (This computer / Cloud / Machines), "This computer — connect it" on web, term "cloud workspace". (DONE.)
- R4 Fix onboarding on the same terms. (DONE; re-verify live.)
- R5 Refuse removing a sandbox provider key that workspaces still use. (DONE: c363e173a8.)
- R6 Org sandbox keys only on hosted; per-project prebuild branch list; one prebuild per key, old deleted at once, no sandbox tracking; `.claxedo/` scripts only. (Doc updated.)
- R7 Codex agent's 31 commits must be acceptable — adversarial review, keep/rewrite/drop. (FIXED: merged b9cac5a7be; 14 kept/rewritten, rest dropped.)
- R8 OpenCode must work on the ChatGPT plan. (FIXED: bd17cf7447 on dev; verify live.)
- R9 Test approvals, isolation, MCP and expiry/eviction live. (OPEN)
- R10 Session Delete action: fine to skip for now. (DECIDED)
- R11 Cloud workspaces list: keep the concept, make the list meaningful (name, branch, status w/ reason, sessions, last used, Start/Stop/Delete) and merge with "Where it runs"; revisit per-session ephemeral sandboxes after prebuilds. (DECIDED by Claude per recommendation while owner away — owner may override.)
- R12 Add an explicit "never" rule for AI-slop decoration (accent left borders/brackets) to the app AGENTS.md. (OPEN, batch A) (FIXED a77a36312b: rules in packages/claxedo-app/src/ui/AGENTS.md "Visual restraint" — app AGENTS.md has a foreign uncommitted edit, so placed beside the shared UI patterns)
- R13 Loader delay threshold 100 ms → 50 ms. (OPEN, batch D) (FIXED 04a05a1ead)
- R14 Telemetry must be good enough to drive product decisions. (OPEN, batch C) (FIXED pending the owner setting the PostHog key on staging)
- R15 (2026-10-05) No backward compat anywhere; go free. Deliver a clean, verified, intuitive Claxedo WEB UX in ~6 hours: extremely smooth, predictable, not intimidating/daunting, easy to navigate. No PRs — merge straight to dev. (DECIDED)

- R16 (2026-10-05) No "This computer — connect it" and no "This computer" label: machines appear by their own name in one Machines group (web and desktop; the desktop's own machine shows its real name). With no machine connected, no pseudo-row — a footer action "Connect a machine…" next to "New cloud workspace" opens the connect instructions. Apply to the Where picker, onboarding, project settings and Settings → Machines. (OPEN, batch A2) (FIXED bf081f4dff)

- R17 (2026-10-05) No "sole machine" assumptions anywhere: a person connects many machines and cloud workspaces, and the web is none of them. Remove or fix every feature that assumes "this machine" (local scans, local installs, local CLI logins/quotas, "this computer"/"this server" copy, Personal marketplace). Where a feature is per machine, it lives on that machine's row/scope and names the machine. (DECIDED; sweep in progress) (FIXED root bf081f4dff; partials S3/S7/S11 need runtime routes)

## Batch A — settings, web gaps, polish
- A1 New cloud workspace popover: help text under input → proper title + description above; uneven left/right padding. (O: N1,N2)
- A2 Harness/model picker: "Select agent" label vs Harness/Model; empty "No model results" dead end at body weight, no action; low-contrast rows while loading (look disabled); "NATIVE SDK" jargon; effort control = unlabeled dots; default Pi model should be newest, not top of list; "Openai Codex" casing; list shifts under the cursor while loading. (P1–P6) (FIXED bf081f4dff)
- A3 Blue left bracket/border before the model chip = AI slop; remove + AGENTS.md rule (R12). (O1)
- A4 Cloud icon in the Where chip ≠ cloud icon in sidebar rows — one icon. (O2) (FIXED bf081f4dff)
- A5 Settings → Usage → Usage limits "unavailable" on web (no hosted quota source). (O3) (FIXED a77a36312b: tab removed on web; hosted quotas would leak org members' accounts — see X10)
- A6 Settings → Organization says "Sign in" while signed in (access.principal not populated on web). Same root likely hides the Sandbox keys group (org admin check). (O4, O18) (FIXED a77a36312b; Sandbox group gated by server can_manage — verify live)
- A7 Settings → Models empty account state = thin full-width grey bar, no text. Real empty state. (O5) (FIXED a77a36312b)
- A8 Settings → Connections: "Agent connections" meaningless; integration tags "code-host / work-source / docs" jargon. (O6,O7) (FIXED a77a36312b)
- A9 Linear connect = inline form in the list → dialog. (O8) (FIXED a77a36312b)
- A10 Machines: add-a-machine instructions too prominent (tone down); global "Remote access — Not available yet" block nonsensical with no machines; remote access is per machine. (O9,O10) (FIXED a77a36312b)
- A11 Settings → Projects: underline on project-name hover — remove. (O11) (FIXED a77a36312b)
- A12 Project settings cloud workspaces list meaningless + "This project has nowhere to run yet." contradiction → per R11. (O12) (FIXED a77a36312b)
- A13 App plugins page: duplicate "App plugins" heading; loud orange warning box. (O13) (FIXED a77a36312b)
- A14 Models page on web shows "Scanning this machine…" (no machine on web); clarify account sources on desktop too. (O15,O16) (FIXED a77a36312b)
- A15 Account row badges (laptop/cloud icons) need text ("Works locally and in cloud workspaces"). (O17) (FIXED a77a36312b)
- A16 Web has no way to add sandbox provider keys (group hidden — A6), choose machine size (slice 5), or set up a project environment (startup script/env rows read None with no obvious edit; setup scripts slice 3). Make the existing ones reachable/editable on web; plan the rest. (O18) (PARTIAL: sandbox keys drawer; startup script per R6 read-only line; env on web = X6)
- A17 No cloud VM usage meter / list of active cloud workspaces anywhere (Usage shows tokens only). Add a Cloud section (active now, VM minutes, cost) — depends on C. (O19) (PARTIAL a77a36312b: Cloud running-now + Stop; since/VM minutes → batch C)
- A18 Home empty state "C" logo reads as a spinner. (H1) (FIXED 04a05a1ead)
- A19 No visible Settings entry (avatar only). (H2) (FIXED a77a36312b)
- A20 Where picker rows show no per-workspace status. (H4) (FIXED bf081f4dff)
- A21 Terminal picker shows retired "Gemini" and raw command lines as subtitles. (O20) (FIXED 4e26411308)
- A22 New cloud workspace form has no branch choice; creation deferred to first send — say so clearly or create now. (N3,N4) (FIXED bf081f4dff: dialog with name+branch, creates and starts now)

- A23 Asleep line "This workspace is asleep. Your next message wakes it." needs a "Wake now" button in the line (it had "Start workspace" before the picker rework — regression); while waking show progress ("Starting — about a minute") in the same line. (owner 2026-10-05) (FIXED: b3e4171b27; verify live.)
- A24 Branch chip shows "Branches unavailable" while the workspace sleeps — show the workspace's last known branch (from the control plane row), not a dead chip. (PARTIAL bf081f4dff: last known branch when the record has one)

- A25 Project chip's repository picker popover is not scrollable: the repo list is cut off and the "Name" field below is unreachable (popover taller than the viewport). Make it a dialog (R: forms are dialogs) or a bounded scroll area. (owner 2026-10-05) (FIXED bf081f4dff)
- A26 Composer shows a "Resolving harness…" pill (with a Permissions button) as if the app will pick one by itself — it won't. Say what to do: "Select a harness" as the clear call to action in the harness/model control; never a fake progress state. (owner 2026-10-05) (FIXED bf081f4dff)

- A27 Create project form: "Cloned on this server. A private GitHub repository clones with the connected account." — "this server" means nothing on web; rewrite ("Claxedo clones it with your GitHub account"). "Choose from GitHub" renders as plain text, not a control → segmented control per principle 11. Name field help "Leave empty to name it after the source." → principle 9/10. (owner 2026-10-05) (FIXED bf081f4dff)
- A28 Project picker shows the raw project id (prj_…) under each project name → show the repo or nothing (principle 1). (FIXED bf081f4dff)
- A29 Repo-wide form/control decisions (owner asked): field anatomy, optional marking, placeholders, two-mode input switch, dropdown footer divider + ellipsis rule — DECIDED in UX-PRINCIPLES.md §9–12; apply across the app (onboarding, create project, new cloud workspace, connect dialogs, settings forms). (FIXED for touched forms bf081f4dff)
- A30 Activity view rows: use two-line card rows (title / project · where · age) like before — more room, better scan; cloud icon too big — text-sized. (owner) (FIXED 04a05a1ead)
- A31 Logout: user menu closes and the app freezes for a few seconds; keep the menu open and show "Signing out…" until done. (owner) (FIXED 04a05a1ead)
- A32 Login screen is very ugly: two-column layout — one side minimal artwork (extend the background-image style, very minimal), the other the sign-in with the GitHub logo on the button and a short motivating line. (owner) (FIXED 04a05a1ead)

## Batch B — functional bugs
- B1 First message on a NEW cloud workspace: workspace created, NO session, draft silently restored, lease stuck acquiring; no "creating/starting" state; failed send shows no error. (F1–F3) (FIXED: b3e4171b27; verify live.)
- B2 Cloud workspace inventory has no status → every row "Failed — unknown status: undefined". (F4) FIXED on dev b9cac5a7be.
- B3 Composer draft text leaks across sessions. (F5) (FIXED: b3e4171b27; verify live.)
- B4 Start a terminal on web → "Your sign-in expired or was refused" while signed in; connection mint is fine, failure at relay/runtime PTY step; message misleading. (F6) (FIXED 4e26411308: workspace-role terminal authority, "Not allowed" class; live relay connection still hangs → X13)
- B5 Pi session-host transcripts not erased when a cloud workspace is deleted (needs control plane → relay → session-host delete). (known gap) (FIXED: hosted sessions deleted through their host before sandbox+row; 502 retryable)
- B6 Pi model list for a draft on an asleep cloud workspace can't load (should come from the account catalog/DO, not the VM). (known gap) (FIXED 4e26411308)
- B7 e2e flows 24 and 48 fail on dev (pre-existing; diagnose). (FIXED: flows 12/24/48/51 green web+phone; flow 31 "a thousand sessions" = ACP launch deadline under load, not fixed)
- B8 Unexplained one-off 415 "Cookie-authenticated browser mutations require a JSON content type" seen in the owner's browser (watch).

- B9 False "Pi is not set up — Add credentials in Settings → Providers" notice in a Pi session that works on the ChatGPT plan; "Settings → Providers" does not exist (it's Models). Notice logic reads the wrong source; fix the condition + destination. (owner 2026-10-05) (FIXED 4e26411308)
- B10 Claxedo MCP session tools are not available inside a cloud Pi session ("Claxedo MCP session tools aren't available here") — MCP live test (R9) fails. Wire the Claxedo MCP server into Pi cloud sessions (per-session MCP was a Pi-rebuild requirement). (BLOCKED→lane b2: needs per-session MCP credential for hosted /api/claxedo/mcp) (FIXED: per-turn MCP token bound to owner+session+workspace, ≤10 min, only /api/claxedo/mcp — NEEDS security review in round 2)
- A33 Waking a cloud workspace on send shows only "Thinking": add the lifecycle strip in the notice slot + pending message (principle 17). (owner) (FIXED: b3e4171b27; verify live.)
- A34 Multiple notices above the composer: one slot, priority order, "+N more", dedupe (principle 16). (owner) (FIXED: b3e4171b27; verify live.)

- B11 Marketplace on web: catalog fails with "The plugin catalog answer does not match its contract" (red box) after a skeleton; the hosted plugin catalog response and the app's parser disagree — fix the contract at its owner, add a route+parser test. (owner 2026-10-05) (FIXED 4e26411308)
- B12 Marketplace "Personal — installed for other harnesses" section shows "Could not read this machine's harness installs: This is the Claxedo control-plane API; it serves no pages." on web. Owner: the "Personal" concept makes no sense (you connect many machines and cloud workspaces) — REMOVE the Personal section and its filter chip entirely. (owner ruling) (FIXED 4e26411308)
- A35 Marketplace filter chips "All / Claxedo 0 / Personal 0 / + Add source": with Personal removed, revisit — counts of 0 next to an empty catalog read as broken; show the catalog's real sources only. (FIXED 4e26411308)

- A36 Marketplace "+ Add source" expands a bad inline form (explanation + GitHub repository + Ref + Add/Cancel) above the error box — move to a right-side drawer (principle 18). (owner 2026-10-05) (FIXED 4e26411308)

## Batch C — telemetry
- C1 Hosted web app sends NO user-behavior events (posthog-js removed; /api/claxedo/track mounted only locally; staging lacks CLAXEDO_POSTHOG_KEY/TELEMETRY_MODE; server error capture only in tests). (T1,T2) (FIXED: hosted track route, one app path, allowlist, PostHog when configured — owner sets key; see below)
- C2 Add: onboarding funnel, session_started, turn_completed (from turn-usage row), workspace created/ready/failed/woken/deleted, permission_decided, ui_error_shown, feature_used, lease opened/closed with active_ms (cost). One owner each. (T3) (FIXED: event table in packages/claxedo-server/src/platform/telemetry/README.md)
- C3 Privacy: drop jti/relay URL from runtime_access_token.minted; hash channel external user ids; stop control_plane.auth.signed per-request event; per-event property allowlist on the track route. (T4) (FIXED)

## Batch D — loading / performance
- D1 Blank dark screen on first load until a 3.9 MB main JS parses (no logo/spinner); code-split. (L1,L3) (PARTIAL 04a05a1ead: themed shell outline in index.html; lazy routes; eager JS 3918→3543 KiB raw, 1101→1000 KiB gz; next lever ~600 KiB non-English locales at startup)
- D2 Serial startup API waterfall (session 0.9 s → workspace lists 1.2 s → session list 1.1 s + runtime git/status 2 s). (L2) (FIXED 04a05a1ead: 3→2 stages; shell ready 1411–1465 → 915–936 ms at 150 ms latency)
- D3 Session switch loading: sidebar list wiped though cached; two loading styles; composer hidden while history loads; no reason past ~2 s; no error+Retry; 50 ms threshold. (O21, R13) (FIXED 04a05a1ead)

## R17 sweep — sole-machine assumptions (found 2026-10-05; root: `server/capabilities.ts:31-43` + `server/machines.ts:37-40` derive thisMachine/features from transport.loopback)
- S1 Marketplace Personal (= B12). Batch B. (FIXED 4e26411308)
- S2 Absolute-path file tabs read through the desktop bridge → web always "cannot be opened on this computer"; desktop fails for other machines. Read through the placement's runtime; "Open externally" desktop-only for own placements. (`files/api.ts:7`, `server/files.ts:51-58`, `timeline-link-open.ts`) (FIXED bf081f4dff: inside-workspace paths via runtime; outside = desktop on owning machine)
- S3 localhost link preview loads the viewer's own localhost (web iframe, desktop webview) — wrong machine for cloud/remote. Forward via placement runtime/relay or don't offer; drop "use the desktop app" hint. (`browser/tab.ts`) (PARTIAL bf081f4dff: honest note + open in new tab; port forwarding needs a relay route)
- S4 Desktop Settings → Machines lists only itself (local server `issuesSessions=false`); list the account's devices, mark this one. (`server/machines.ts:52-61`) (FIXED a77a36312b; isThisMachine join fix in lane a2a)
- S5 Global "Remote access" row → per machine row (= A10). (Global block removed; per-row switch BLOCKED: app has no way to turn remote access on — rows show state in words.)
- S6 Onboarding execution choices: one per connected machine (named) + cloud; no "Just this machine"/"connect it"; copy "on this machine". (= R16) (FIXED bf081f4dff)
- S7 "New local worktree" → "New worktree on <machine>" for any machine's folder placement. (PARTIAL bf081f4dff: serving machine only; other machines need a worktree route)
- S8 Desktop placements on other machines show a path not a name (fixed by S4).
- S9 Where picker connect row → footer "Connect a machine…" (= R16). (FIXED bf081f4dff)
- S10 Fake `"this-machine"` machine id in `wire/placements.ts:28,43` — remove. (FIXED bf081f4dff)
- S11 Folder picker browses the app server's disk → takes a machine, browses through its runtime. (PARTIAL bf081f4dff: desktop only; cross-machine browse needs a route)
- S12 Machine CLI-login scan/quota for one machine only; per machine rows; stored keys belong to the account (copy "Stored on this computer"/"Only workspaces on this computer"); Pi own/org source hidden on desktop → show on both. (FIXED a77a36312b)
- S13 Loopback-only capability flags (harness "unavailable: runs on a machine", unused terminals/browser/remoteAccess) — remove; availability per placement. (FIXED bf081f4dff)
- S14 Copy: terminal "Open a session on this machine…", tasks preset "this machine's current skills" → name the machine. (FIXED bf081f4dff)

## Codex-repair integration (R7) — MERGED to dev b9cac5a7be (14 commits; KEEP/REWRITE/DROP table in session notes). Open from it:
- X1 (decision) Codex command sandbox on Boat needs nested userns blocked by Docker default seccomp/AppArmor. Options: Codex's 464-line profile (minus CHOWN, live apt check) vs `seccomp=unconfined,apparmor=unconfined` (single-tenant VM). Recommendation: unconfined (one line, the VM is the boundary). OWNER DECISION — not done.
- X2 Boat health-timeout failures retried as transient → use `cloud_runtime_boot_failed`. (FIXED: 9a281778fa)
- X3 OpenCode with a managed (hosted) ChatGPT login — integration base predates bd17cf7447 (R8), which binds it; verify live with R8.
- X4 (FIXED 4e26411308) Stopped OpenCode workspace says "OpenCode is not set up" → modelAvailability + "a send will wake it" (same class as B9).
- X5 Project VM size + setup command never reach Boat provisioning (slice 3/5).
- Note: cx-integrate dropped the asleep card's Start button citing an older rule; owner's newer A23 wants "Wake now" — A23 stands (lane first-send).
- X6 Project environment variables are not editable on web: the hosted control plane has no project-config write route. Per R6 there is no startup-script editor (scripts live in the repo's `.claxedo/`). Env vars need a hosted route plus a secret-safe store; open, after this pass.
- X7 Where-picker cloud workspace for a PRIVATE connected repo is created without `repoConnectionId` → clone may fail. (lane a2a) (FIXED bf081f4dff)
- X8 Where chip falls back to another workspace when the new placement isn't in the catalog yet. (lane a2a) (FIXED bf081f4dff)
- X9 e2e failing on base dev: flow 12 cold open, flow 24 send-wake, flow 24 replaced runtime, flow 24 phone rail strict-mode (= B7 scope).
- X10 Hosted usage quotas: the quota reader lists every org credential, so members would see each other's accounts — needs a per-person scope before a web quota view.
- X11 Models shows "Add an account" twice for an empty harness (tab bar + empty state).
- X12 e2e 33-phone Marketplace can't find the built-in "claxedo" plugin (batch-b to check vs dev). (FIXED 4e26411308)

## Review round 1 findings (orchestrator, from lane screenshots; fix as one batch after lanes land)
- V1 Models page with no accounts: every harness repeats an Accounts/Models tab bar + empty box + two "Add an account" (X11) → five identical blocks read as daunting. One compact row per harness ("Claude Code — No account yet · Add an account"); tabs only once a harness has an account.
- V2 Project settings "Where it runs": a machine row shows the full temp path as the main secondary line (wraps to two lines) → show the folder name with a `~`-shortened path, full path on hover/copy.
- V3 Project settings has a redundant "Settings" subheading under the project name.
- V4 Usage with zero usage renders the full dashboard (0 tokens, empty chart, rows of 0 / 0% bars) → one empty state ("No usage in the last 7 days — tokens and cost appear after your first turn") and keep the period switch.
- X13 Cloud terminal live connection through the relay hangs on "connecting" (also on dev with a Codex-session terminal). P0. (FIXED test infra; VERIFIED live 12:10)
- X14 Gemini quota retry message residue in `transcript/session-retry.tsx` (retired model). (FIXED in app/harness; leftovers X25)
- X15 Marketplace install sheet shows raw harness ids ("pi") as labels. (FIXED)
- X16 Flow 12 Tasks/Marketplace panel ("Select a workspace to use this panel") fails on dev. (FIXED)
- X17 Linux CI: harness opencode conformance "an MCP prompt is listed as the session's command…" got ["init","review"] without "docs:review" on dev 4e26411308; passes on macOS (incl. 3 parallel). Suspect `mcp-settle.ts` settles on tools before OpenCode lists MCP prompts. (lane b2 to diagnose; watching the e4c6beaf94 deploy rerun) (DIAGNOSED: mcp-settle treats a tool-less server settled after first tool reload; mcp.prompts.changed never reaches plugins — needs another signal; OPEN)
- Process note: 04:20–10:05 IST every subagent stopped with an API 403 (org disabled subscription access for Claude Code); lanes resumed at 10:07.
- X18 packages/claxedo-app/AGENTS.md "Loading states" still says 150 ms; code uses PLACEHOLDER_DELAY_MS = 50 ms and SLOW_LOAD_MS = 2 s (src/lib/delay.ts). Not edited because the main checkout holds foreign uncommitted edits to that file; apply when they are committed.
- X19 Harness/model picker popover doesn't flip when there's no room above it.
- X20 Home with projects but no placement shows "Nothing is open" with no action.
- X21 e2e failing on clean dev: 12-first-page cold open + setup notice, 12-switch-paint ("Loading models"), 12-warm-return heap, 12-workbench-shell:170, 48-startup:13, 31 "a thousand sessions" (ACP launch timeout). (= B7 scope, lane b2) (FIXED except flow 31)
- V5 (live) Sidebar: a brand-new session's row shows only a spinner with no title until the title arrives → show the first words of the prompt / "New session".
- LIVE 2026-10-05 10:20 (staging e4c6beaf94): VERIFIED A6 (org shows role Owner + member "You"), A14 (no "Scanning this machine"), A16 sandbox group visible, A19 Settings in sidebar, B1/A33 first send shows "Waking live-check-1005 — Starting the machine, about a minute" with the message pending; failed send keeps the message + server reason + Retry.
- X22 First send on a new cloud workspace failed: "Agent Plugins runtime apply failed (404): 404 Not Found" — staging enables Agent Plugins but the image I built (…94b06b9cb4-v8) was the plain runtime (workflow input agent_plugins=false). Rebuilding with agent_plugins=true. Product gap: an Agent-Plugins-enabled deployment accepts an image without the entrypoint and fails only at first send; the deploy (or the image var check) must refuse the mismatch, and the user-facing error should be plain ("This cloud workspace's image is missing a feature this deployment needs").
- V6 (live) Marketplace catalog shows a skeleton for ~8 s on staging before the list appears — find the slow read (D-batch).
- Process note: Codex review (gpt-6.1-sol) unavailable — usage limit until 2026-10-10 02:43; review round 1 runs on two read-only Opus reviewers.
- F1 (P1, live) Per-browser state scope `principalScope()` (`shell/view/app-shell.tsx:32`) is `machine:<id>` or the bare string "machine" — on the web every signed-in account in one browser shares the same drafts, workbench layout and preferences (staging key `claxedo:composer:<api>:machine:this-machine:draft:…`). Scope must be the signed-in user (+ org) from the sign-in, machine only for an unsigned local server.
- F2 (P1, live) A failed first send on a new cloud workspace keeps its text in its draft, but after a reload the draft's Where falls back to another workspace (ws_muu0…) instead of the created `live-check-1005`, and Retry is gone — the next Enter would send the prompt to the wrong workspace. Persist the draft's Where (placement id once created) with the draft.

## Review round 1 (dev bf081f4dff) — 39 findings in 2026-10-05-review-r1-findings.md (S-1..S-11 server, A-1..A-28 app)
- Fix batches: r1-app (A-*, S-6, S-7, S-9, S-11, V1, V3–V5, X19, X20, F2) IN-PROGRESS; r1-server (S-1 P1 viewer sees terminal output, S-2, S-3, S-4, S-5, S-8, S-10) queued for the next free slot.
- P0 live: cloud Pi turn "500 turn_authority_unavailable" + resend hangs + composer model reset to "Select model" (staging 04a05a1ead, session ses_154e…) — lane live-turn diagnosing with wrangler tail.
- P0 live turn: CAUSE = `/turn-delivery` threw on Agent Plugins apply (relay → sandbox 404: sandbox bx_cb4bmjjr was created on the plain image …94b06b9cb4-v8; changing CLAXEDO_SANDBOX_IMAGE never reaches an existing sandbox). FIXED 20cec4e87b: plugin apply failure → 502 agent_plugins_unavailable, every route failure → typed JSON code; composer keeps the session model through an empty options answer ("Select model" bug).
- X23 An image change never reaches existing sandboxes: a workspace created on an older image keeps it forever (here: missing Agent Plugins route). Needs a policy: recreate on next start when the deployment's image differs (workspace state persists in the volume/repo), or refuse with a plain "restart this workspace to update" action.
- LS-1 (P1) Session event stream opened against the workspace sandbox never re-routes to the session host DO when it becomes known → results appear only after reload. Given to r1-app.
- LIVE 2026-10-05 12:00 (staging 20cec4e87b): VERIFIED Where picker names workspaces with status words (Running / Setting up), "New cloud workspace…" + "Connect a machine…" footer, no "This computer" row; New cloud workspace dialog (title, description, Name, Branch optional) creates and closes; first send shows "Waking live-check-2 — Starting the machine, about a minute".
- V7 Two unnamed workspaces both read "Cloud workspace" in the picker — indistinguishable; the brief asked "Cloud workspace · <branch>" (and their "Setting up" has lasted 13 h = S-4 stuck lease shown as setting up).
- V8 New cloud workspace dialog Branch placeholder says "main" while this repo's default branch is dev — placeholder must be the real default branch (or none).
- V9 After Create, the dialog closes and nothing says the workspace is starting (chip shows "Branches unavailable") until a message is sent — show "Starting live-check-2…" in the notice slot right after create.
- LIVE 12:10 (staging 20cec4e87b, image …219c81f426-v8): VERIFIED end-to-end cloud turn chain (create → start → session host → turn delivery → Agent Plugins → provider): provider answered "Usage limit reached — Choose another model or account. Account: kanusdlp@gmail.com (Pi)" = the owner's ChatGPT plan quota, rendered cleanly. VERIFIED B4/A21 cloud terminal: picker Shell/Claude/Codex/Cursor with plain descriptions, shell connects, `git rev-parse --abbrev-ref HEAD && whoami` → dev / root.
- V10 Terminal pane text sits flush against the left edge (no gutter); the rail's terminal row is a bold monospace "Terminal" with no workspace line, unlike the two-line session rows.
- C-OWNER (owner action, no secrets set by Claude): `gh variable set CLAXEDO_STAGING_TELEMETRY_MODE --env staging --body on`; `gh variable set CLAXEDO_STAGING_POSTHOG_HOST --env staging --body https://us.i.posthog.com`; `gh secret set CLAXEDO_POSTHOG_KEY --env staging`; then `gh workflow run deploy-staging.yml -f components=control-plane`.
- X24 VM minutes this period (A17): sandbox_leases keeps only the current boot — needs a lease history table (active_ms now flows to PostHog on workspace_stopped).
- X25 Gemini leftovers outside app/harness: runtime terminal-start pattern + agent hooks, Vercel driver installs gemini-cli, desktop PATH comment, a Gemini label in usage limits. (no-trace-of-retired-models rule)
- X26 Phone cannot create a terminal (rail button hover-only, header button desktop-only).
- X27 A cloud terminal created through the API doesn't appear in the rail until reload.
- X28 Launch gate reports "EPIPE" instead of the real exit reason.
- X29 Hosted OAuth introspection answers 500 to unknown bearers (should be 401).
- X30 Flow 31: 50 concurrent ACP launches exceed 10 s start deadlines under load — decide a launch concurrency limit.
- X31 B10 gap: a Claxedo MCP tool aimed at the Pi session itself goes to the machine, which doesn't hold that session.
- S-8 (OWNER DECISION) Cold start runs inside the start request; Cloudflare cancels request-tied work on client disconnect (waitUntil +30 s only), leaving the lease `acquiring` until the 60 s stale takeover — cost ≤ ~1 min, no data loss. Proper fix = provisioning in a Durable Object alarm (15 min wall), which needs a NEW DO class = an irreversible wrangler migration tag on staging + prod (base and agent-plugins artifacts already differ v1 vs v1+v2). Not done; owner to choose: new DO class (tag v3 both artifacts) vs reuse an existing DO vs accept.
- X25b (OWNER DECISION) Usage → limits still shows a machine "Gemini CLI" quota card (otherAgent, next to Kimi/Kiro/Grok) for a machine where the Gemini CLI is installed; terminal-agent Gemini support (status hooks, image installs) removed. Keep the quota card or remove the Gemini quota adapter too?
- Review round 1 server batch MERGED ef9c7350df: S-1 (viewers get no pty frames), S-2 (pty sessionId removed), S-3 (retry reuses reservation; local path still can duplicate), S-4 (backoff = provisioning; plain failure reasons), S-5 (devices = every unrevoked enrollment with online/offline/paused), S-10 (meter from acquire outcome), X22 (Agent Plugins deploy refuses image without -agent-plugins tag; plain 404 message), X23 (Boat records booted image; outdated → 409 cloud_runtime_image_outdated "Restart to update"; start replaces container keeping files). S-8 owner decision (option without new class: relay per-workspace DO alarm → internal ensure endpoint).
- DEPLOY NOTE: next staging deploy needs a rebuilt Agent Plugins image whose tag carries -agent-plugins (workflow agent_plugins=true) and CLAXEDO_STAGING_SANDBOX_IMAGE set to it.
- Review round 1 app batch MERGED 9921ede431: A-1…A-28, S-6/A-11, S-7, S-9, S-11 (test), V1, V3, V4, V5, V8, V9, V10, X20, F2/A-13 (Edit message + persisted draft Where), LS-1 (stream re-routes to session host), S-5 Paused, X23 Restart to update, flow 15 stale test. X19 not reproduced (flow 54 asserts in-viewport). V7 partial (branch only when the server sends one).
- b3 (leftovers) committed X17 (mcp-settle waits for command.updated), X30 (ACP launch bound = availableParallelism, deadlines from dequeue), X25, X26, X28, X29 (non-clx_at_ bearers inactive → 401), X31 (own-session MCP calls to the session host); X27 + real-home OpenCode read ("supermemory-init" seen in conformance) + flow 31 idle-agent policy in progress.
- X32 Flow 31 "a thousand sessions": each idle scripted ACP agent holds ~85 MB; 1000 live agents exceed 24 GB → product needs idle ACP agent release (or the test creates rows without live agents).

## Review round 2 (dev 9921ede431) — findings in 2026-10-05-review-r2-app.md (15) + 2026-10-05-review-r2-server.md (6)
- P1 S-7 not fixed on desktop (Show not keyed + desktop signed-with-empty-user = signedOut) — cross-user drafts/panes leak.
- P1 Session MCP tools on the session host die ~60 s after the first bearer rotation (MCP session keyed by token digest; client cached).
- P2 member driving owner's session gets owner-identity MCP without ownerDriven guards (detached session_create, owner's session reads).
- P2 Retry permanently 403 after a first-input failure (compensated reservation reused) — regression from S-3.
- P2 notice dedupe keeps a stale Wake now closure (wakes the wrong workspace); LS-1 re-route drops frames (no onGap); Restart-to-update failure silent; A-14 draft composer options still from the original placement.
- Fix batches: r2-server, r2-app.
- b3 MERGED (see git log): X17, X25, X26, X27 (workspace stream ?sessions=none, one owner placement-streams), X28, X29, X30, X31; harness tests now run in a temp HOME via `bun run test:files` + preload guard.
- INCIDENT X33: harness OpenCode conformance tests ran OpenCode in-process with the REAL home: read ~/.config/opencode/command/supermemory-init.md and wrote under the real ~/.local/share and ~/.cache. Fixed for harness (temp-home runner + guard). workspace-runtime bun tests have the same problem (preload sets HOME at runtime, which bun ignores) — lane needed.
- X32 (OWNER DECISION) Flow 31 "a thousand sessions" exceeds 24 GB (≈85 MB per idle ACP agent). Options: U10 from docs/plans/2026-10-03-harness-lifecycle-and-memory-plan.md (release fully idle execution, own lane), or a narrower ACP-only LRU cap on live agents. Not started.
- Review round 2 server batch MERGED (561a1a07e0 tip): #1 stateless hosted MCP mount + resend-once client + one isolate token cache shared with own-host routing; #2 first-party MCP only on the owner's turn; #3 server session_reservation_spent; #5 tool groups in delivery generation; #6 no workspace delete while a hosted session remains. Out of scope: an outside MCP client signed in as a person still keeps its MCP session in one isolate (404 → re-initialize).
- X33 FIXED repo-wide: script/test-home/ (run.mjs temp HOME/USERPROFILE/XDG + strips harness/Claxedo overrides; guard.mjs refuses unless os.homedir() is the temp home) used by harness, workspace-runtime, session-core, server-core, mcp, local-server, server + CI scripts. Reachable real-home paths before: ~/.claxedo (credentials.json, workspaces/), ~/.workspace-runtime, ~/.codex, ~/.claude, ~/.cursor, ~/.pi, ~/.config/opencode, ~/.local/share/opencode, ~/.cache/opencode — not inspected/cleaned (owner decision).
- LIVE 16:30 (staging 382110b5d1, image …d2a40fcc55-agent-plugins-v8): app loads signed in; Where chip reads "Cloud workspace" for unnamed; session view + usage-limit notice render; rail two-line rows.
- V11 Rail second line for an unnamed cloud workspace shows only the cloud icon then "· 17h" — the visible name was dropped (r2 #13), leaving a dangling separator. Show "Cloud workspace" (dictionary) or drop the separator. (FIXED 545593c7b3)
- V12 After opening another session from the rail, the previously open row stays highlighted with a check mark alongside the new one — two rows look selected. (FIXED 545593c7b3)
- V13 Session title generated as "`git rev-parse --abbrev-r…" (starts mid-prompt with a backtick) for the prompt "Reply with exactly LIVE-OK-2 and the output of `git rev-parse …`" — title generation picks a fragment. (FIXED 545593c7b3)
- Review round 2 app batch MERGED 2b4d4c56cf (all 15 + server #3 app half/#4); closure-runner fix cea7fecac1; desktop pinned op 382110b5d1; final polish 545593c7b3.
- LIVE 17:20 (staging 545593c7b3): V11 VERIFIED (rail reads "Cloud workspace · 18h").
