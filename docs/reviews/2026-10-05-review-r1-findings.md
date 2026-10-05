# Review round 1 findings (dev bf081f4dff) — fix as batches

## Server / security / races (reviewer S)
- S-1 P1 Viewers receive terminal output: terminals are now session-less; session-less `pty.*` frames are not sensitive, so `wr/events` (workspace grant from `authorizeHost` hostAccess "read", no role check) delivers `pty.exited`/`pty.stream{kind:"exit"}` `tail` (16 KB) and `pty.created` command/args/cwd to viewers. Files: workspace-runtime `pty/terminal-authority.ts:63`, `pty/index.ts:468-471`, session-core `routes/events.ts:499-502`, `event-delivery.ts:240-242`. Fix: drop session-less pty frames for viewers in `sessionEventDeliveryPolicy` (or mark sensitive and drop tail from workspace frames).
- S-2 P2 `CreateInput.sessionId` still accepted and unverified but drives event scoping (+ agent-hook prompt/lastAssistantMessage kept) → an editor can inject terminal output into another member's private session stream. Remove `sessionId` from pty CreateInput/Info/ownership scope/event-privacy cases (`pty/session-types.ts:34`, `routes/pty.ts:113-176`, `routes/agent-hook.ts`, session-core `routes/session-event-privacy.ts:166-171`).
- S-3 P2 First-send Retry re-runs `stores.list.create` with a fresh reservation (no idempotency) → lost create response + Retry = duplicate paid session. Keep the reservation/operation id across retries or check first (`session/view/first-send.ts:40-50`, `draft-session-screen.tsx:44-51`, `server/sessions.ts:42-58`).
- S-4 P2 `lifecycleOf` (server-core `workspace/cloud-runtime-readiness.ts:28-36`) maps any non-ready/acquiring/stopped/destroyed lease (e.g. `unavailable` in retry backoff) to failed with generic `runtime_lease_not_ready`; real `lastError` dropped. Map backoff to provisioning/retrying; surface boot-failure reason in words.
- S-5 P2 Devices route = only machine list but assumes one machine: lists machines with assignments + only the most-recently-seen enrollment (limit 1), paused filtered out (claxedo-server `authority/adapters/d1/host-assignment-devices.ts:26-52`, `hosted-remote-access-service.ts:20-40`, `host-access-authority.ts:723-734`). Build from every unrevoked enrollment joined with assignments; Paused as a state.
- S-6 P2 Raw `ws_` ids as placement labels (Tasks sets display_name = id; catalog uses it) — second owner of display name vs `cloudWorkspaceName`. Resolve once in the wire/catalog decoder; delete per-view helper. (= app A-11)
- S-7 P2 Per-browser state scope `principalScope()` (`shell/view/app-shell.tsx:33-36`) = machine[:enrollment], not user; desktop sign-out A → sign-in B sees A's drafts/panes; README claims otherwise. Include the signed-in user (+ org) in the scope. (= live F1)
- S-8 P2 Start request now runs `ensure` inline (claxedo-server `connections/hosted-connection-info.ts:274-283`, `routes/hosted/workspace.ts:287-292`): the caller waits the whole cold start, boot mode never shown; if workerd cancels on client disconnect the lease sits `acquiring` until stale. Verify workerd behavior; return `provisioning` after acquiring and drive provisioning off-request (DO/alarm) if cancellation is real.
- S-9 P3 Notice republish on every reactive run reorders same-tone notices (`placement-notice.tsx:26-35`, `composer-notice.tsx:19-21`, `notice-slot.ts:29-37`). Republish only on kind/message/tone change.
- S-10 P3 `openingFirstLease` caps + emits `leaseOpened` before acquire (race: two first starts both pass cap, duplicate events) (`hosted-connection-info.ts:222-242`). Decide from the acquire outcome.
- S-11 P3 latent: `wire/placements.ts:39-42,73` cloud rows get `onThisMachine: true` + daemon machineId. Cloud rows: false, no machineId.

## App UX / duplicates / tests (reviewer A)
- A-1 P1 Create project Folder option depends on async `machines.list()` (devices read) — slow/failed read hides Folder; jumpy. One sync `servingMachine()` accessor from boot data; use everywhere (also fixes A-20).
- A-2 P2 `cloud/model.ts:9-15` Start and Stop both shown while provisioning. Stop only (Start only if stalled).
- A-3 P2 `cloud/store.ts:46-52` a failed Stop/Delete paints the workspace as Failed (Stop vanishes while it still runs). Report command failure separately; keep server status.
- A-4 P2 Asleep state publishes two notices of different kinds (`composer/view/harness-notice.ts:44-53` + `session/view/placement-notice.tsx:20`) → duplicate + "+1 more". One kind / drop the harness one.
- A-5 P2 Empty model list always "No models yet — Add an account" even when the account exists and the workspace is asleep; hard-coded English (`harness-picker-model-section.tsx:40-43`). Use account state + asleep check; i18n.
- A-6 P2 Settings → Machines no loading/error state (`settings/view/machines.tsx:93-95`) → "No machine is connected yet" while loading/failing. Skeleton + error/Retry.
- A-7 P2 Where it runs: failed read → empty state; loading blank (`projects/view/where-it-runs.tsx:66-72`). FailureNotice/Retry + skeleton after 50 ms.
- A-8 P2 Rail row "machine" label shows the folder name + "Another machine · shots" (`rail/model.ts:78-82`, `rail/i18n.ts:79`, `session-timeline-skeleton.tsx:80-82`). Use `machineOfPlacement` name; drop "Another".
- A-9 P2 Where chip main label is machine for folder but folder for worktree; web catalog types every non-cloud placement as worktree → chip never shows a machine (`where-chip.tsx:27-31`, `wire/account-catalog.ts:45`); flow 52 test title lies. One labelling rule; fix test.
- A-10 P2 Browser preview copy "served on {{place}}, not on this computer" with raw/empty place; "Open in a new tab" opens viewer's localhost (`browser/i18n.ts:36`, `browser/view/page-host.tsx:15-19`). Name machine/workspace; hide/relabel button for remote.
- A-11 P2 = S-6 (display name owner).
- A-12 P2 Two "Add an account" per empty harness (`harness-section.tsx:92` + `harness-row.tsx:152`). Keep the empty-row button only. (= X11, V1)
- A-13 P2 After a failed first send the composer + Where row are hidden; only Retry (`draft-session-screen.tsx:79-90`) → permanent failure is a dead end. Add "Edit message" restoring the composer with the draft and Where. (Also live F2: after reload the draft's Where falls back to another workspace — persist the draft's Where/created placement with the draft.)
- A-14 P2 Terminal creator agent tiles + draft notice/Wake now query the pane's original placement, not the chosen Where (`terminal/view/terminal-creator.tsx:142`, `draft-session-screen.tsx:79,93`); asleep shows as an error. Read the chosen placement; asleep as its own state.
- A-15 P2 `settings/view/settings.css:42-47` long paths overflow on phone (`.settings-row-description` no overflow-wrap). Fix + flow 53 width check on project page. (= V2: also show folder name with ~-shortened path)
- A-16 P2 Marketplace copy "Every project on this machine"/"this computer" on web (`marketplace/i18n.ts:49,56,130`, `detail-facts.tsx:29`, `install-sections.tsx:67`). "every project in your account"; name machine for machine authority.
- A-17 P2 Connections "Other agents" copy assumes one machine; row description is raw readiness "configured" (`settings/locales/en.ts:35`, `connections.tsx:184`). Name machine; words.
- A-18 P2 `project-create-form.tsx:84-86` "Choosing a GitHub repository isn't available here yet." disabled dead end. Hide the path or offer URL.
- A-19 P2 Connect-a-machine step 2 "Run the first command here" (`settings/locales/en.ts:117`) — on web "here" is a tab. Say where.
- A-20 P3 Serving machine name lookup copied 4×; dead `enrolled || isThisMachine` filters (`create-project-dialog.tsx:12`, `accounts/store.ts:43`, `harness-providers.tsx:41`, `first-project-canvas.tsx:26`, `machines.tsx:74`, `draft-context.ts:32`). One accessor.
- A-21 P3 `access/store.ts:16-25,37-56` dead `memberships`/`orgRole`/org actions; `orgRole` only for exactly one org; second principal owner beside `capabilities().principal`. Delete or derive per org.
- A-22 P3 Two plugin-trust warnings (`plugins/view/settings-section.tsx:19` vs `plugin-warning.tsx`, `plugins/i18n.ts:16-17` "full access on this computer"). One.
- A-23 P3 `composer/view/health-peek.tsx:5-15` draws its own warning row outside the notice slot. Publish via `publishComposerNotice`.
- A-24 P3 Hard-coded English (`settings/connections.ts:84-91`, `harness-notice.ts:46`, `harness-picker-model-section.tsx:42`, `harness-picker-effort-row.tsx:34`). Dictionaries.
- A-25 P3 `accounts/README.md:7` says `onMachine()` reads thisMachine; code uses `capabilities().localExecution`. Rewrite from code.
- A-26 P3 Flow 53 Connections asserts only absences; flow 54 two-line test checks text only. Positive checks.
- A-27 P3 Startup skeleton draws instantly and always in desktop-shell shape (`shell/view/startup.tsx:16`, `shell/shell.css:74-99`) — flashes; wrong on /login. Delay with PLACEHOLDER_DELAY_MS; skip shell shape on /login.
- A-28 P3 Duplicates: Settings in rail + account menu; menu header repeats trigger name; Organization "Your role: Owner" + "You · Owner" tag; "+ Add source…" literal "+" instead of the plus icon. Remove duplicates; icon.

## Orchestrator / live
- V1 Models with no accounts: five identical blocks → one compact row per harness, tabs only once a harness has an account (with A-12).
- V3 Project settings redundant "Settings" subheading.
- V4 Usage with zero usage renders the whole dashboard of zeros → one empty state, keep the period switch.
- V5 New session's rail row shows a spinner with no title until the title arrives → first words of the prompt.
- V6 Marketplace skeleton ~8 s on staging → find the slow read.
- X19 Harness/model picker popover doesn't flip when no room above.
- X20 Home with projects but no placement: "Nothing is open" with no action.
- A24-rest Branch chip "Branches unavailable" when the workspace record has no last branch → record the branch at create/start.
