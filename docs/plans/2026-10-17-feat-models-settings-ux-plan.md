# Models settings UX: accounts, organization accounts, confirmations and surfaces

Base: `origin/dev`. The team-accounts code this plan changes exists only there; local checkouts older than `3165ea625e` lack it.

## Decisions (owner, 2026-10-17)

1. **The account choice stays a radio, with a look that reads as a choice.** The kit's checked radio (`packages/ui/src/v2/components/radio-v2.css`, accent fill with a grey centre dot) reads as an avatar. It becomes a visible selected control in every use of the kit radio. The paragraph "Cloud workspaces use one {vendor} account for you…" (`settings.providers.agents.cloudChoiceShared`) leaves the card and becomes the tooltip of a help icon beside the harness's Accounts tab, shown only where the choice exists (`cloudOnly`, and two or more choosable rows).
2. **Org-paid model keys are "Organization account".** "Team account", "team key" and "Team keys" leave every user-facing string: app locales, server error messages, harness registry text and the usage page. "Team" stays reserved for access groups (D17).
3. **No Team accounts page.** `teamSettingsSection` and its view are deleted. "Add an account" on a harness offers "For me" or "For the organization" to readers with `can("accounts.manageOrg")`. The organization choice offers API keys only, and saves under the harness's vendor provider (`vendorProvider`, e.g. `anthropic`, not `claude-sdk`) through the existing `saveOrgAccount`. The organization account row in each harness's picker carries Check and Remove for managers. Its remove confirmation names every harness the key serves ("Used by Claude Code and Pi").
4. **Every destructive action confirms in a dialog.** `requestConfirm` (`src/ui/confirm.tsx`) gains a destructive confirm button and is the only confirmation. Inline confirms and hand-built confirm dialogs are removed. Forms follow `src/ui/README.md`: a form of one or two fields is a `FormDialog`, a longer or explanatory one is a `FormDrawer`, reading-only content is a `Drawer`, and nothing in a list expands into a form.
5. **Check shows its own progress.** The check icon spins only on the account being checked; other accounts' checks stay available. Its tooltip reads "Check now · last checked {ago}". The age label stays.
6. **An empty Models tab says why.** The copy names the real cause (no project yet, or the workspace cannot answer). Settings moves to the no-wake model read when the VM wake-up session's flow 59 path lands on `dev`.

## Lanes

Each lane owns its files exclusively; run lanes A, B and C in parallel in separate worktrees off `origin/dev`, then D after the VM wake-up work merges. Every lane follows `packages/claxedo-app/AGENTS.md` (no comments, one owner per concept, e2e on the real stack with a recorded red run, flows updated at desktop width and in `phone`).

### Lane A: accounts domain (owns `src/accounts/**`, `packages/ui/src/v2/components/radio-v2.*`)

- [x] Kit radio: the checked state shows a clearly visible indicator in light and dark themes. Screenshots of every kit-radio user, before and after.
- [x] The `cloudChoiceShared` paragraph renders only as a help-icon tooltip beside the Accounts tab, and only when the harness has two or more choosable rows on a cloud-only surface.
- [x] Check: pending state is per account key (`activity()` compares the key), the icon spins while pending (still under reduced motion: no spin, a disabled state), and the tooltip reads "Check now · last checked {ago}". A failed check still shows "Couldn't check · reason".
- [x] Remove account: `requestConfirm` with the destructive button; `ConfirmRemove` and the `confirming` signal are deleted.
- [x] "Add an account" moves onto `FormDrawer` (`DialogProviderConnect` replaced). Managers see "For me / For the organization"; the organization choice shows only API-key methods, maps the provider to `vendorProvider`, and saves with `saveOrgAccount`. Non-managers never see the choice.
- [x] The organization account row has Check and Remove for managers. Remove confirms with the list of harnesses the vendor key serves.
- [x] `teamSettingsSection`, `team-section.tsx`, `team-account-form.tsx`, `team-store.ts` and the `settings.team.*` keys are deleted; `src/accounts/README.md` describes the folded flow.
- [x] Flows: the Models flow covers adding an organization account as a manager, its absence for a member, choosing it, and removing it through the dialog; red run recorded. The member case lives in flow 53 (signed) and is written and typechecked but unrun: signed stacks need macOS `sandbox-exec`.

### Lane B: confirmations and form surfaces outside accounts (owns `src/ui/confirm.tsx`, `src/ui/README.md`, `src/plugins/view/confirm-dialog.tsx`, `src/settings/view/connections.tsx`, `src/settings/view/connect-dialog.tsx`, `src/projects/view/{remove-project,edit-project,create-project}-dialog.tsx`, `src/session/view/docks/goal-dock.tsx`, `src/tasks/view/create-task-dialog.tsx`, `src/rail/view/session-dialogs.tsx`, `src/marketplace/view/install-sheet.tsx`, `src/accounts/view/sandbox-key-row.tsx`, `src/accounts/view/custom-provider-dialog.tsx`)

- [x] `requestConfirm` takes a destructive flag that renders the destructive button variant; Lane A consumes it (land B's `confirm.tsx` change first, or have A rebase on it).
- [x] Inline confirms removed: sandbox key removal, connection disconnect. `plugins/view/confirm-dialog.tsx` deleted; plugin removal uses `requestConfirm`. Remove project and delete goal use `requestConfirm`.
- [x] Forms moved onto the shared surfaces: rename session and create project (`FormDialog`); edit project, create task, custom provider and the settings connect dialog (`FormDrawer`); the install sheet becomes a `Drawer`. The install sheet chooses harnesses and adds the plugin, so it is a form and became a `FormDrawer` (`DrawerInstallPlugin`), per Decision 4's surface rule.
- [x] `src/ui/README.md` states the confirmation rule (every destructive action, `requestConfirm`, destructive button) and the popover rule (anchored, non-modal menus and choosers through the kit's `Popover`).
- [x] Affected flows updated; red runs recorded. Unrun here: sandbox key removal (flow 15-sandbox-keys already fails on `origin/dev`: the unsigned page shows only the sign-in notice), goal delete (07), desktop plugin removal (34), the integration connect drawer (53), integration disconnect and removing another agent (no flow connects one), the install drawer (needs a network plugin source).

### Lane C: naming outside the app (owns server-core credential copy, `packages/harness/src/registry/credentials.ts`, `src/usage/locales/**`)

- [x] Server error messages and harness registry text say "organization account" (`org_account_missing`, `org_accounts_forbidden`, `org_account_rotate_by_put` messages and the usage cloud route).
- [x] Usage page: "Usage by organization account" and its row labels. The organization-scope view renders only signed in, so no flow or screenshot shows it yet.
- [x] `rg -i "team (account|key)"` over `packages/` (excluding `node_modules`, plans and memory) returns nothing user-facing.

### Lane D: Models tab empty state (after the VM wake-up work merges; owns `src/accounts/view/harness-section.tsx`'s Models tab and `src/accounts/view/model-sources.ts`)

- [x] With no project: the copy says models appear once a project exists. With a project whose workspace cannot answer: the copy names that workspace and the failure.
- [x] Settings reads the same no-wake model source the composer uses for an asleep cloud draft; opening the Models tab starts no workspace (asserted against the server's start count). Flow 59 asserts it (no `connection` POST from the page or in the control plane's requests, no new `workspace_ready`/`workspace_woken`) but is unrun: signed cloud stacks need macOS `sandbox-exec`.

## Definition of done

- [x] `bun run check`, `bun run typecheck`, `bun run test` in `packages/claxedo-app`, `bun run test:architecture-ratchets` at the repo root, all on the merge tip.
- [ ] The Models, connections, marketplace, projects and onboarding flows pass on web and phone; every new or changed assertion has a recorded red run. Red runs are recorded. Verified in a Linux container only; the owner's Mac run is outstanding: there every Models, connections and onboarding test body passes but the stack fixture fails at teardown on the container's own Claude CLI reaching api.anthropic.com, the signed flows (53, 59, 01 on the web) need macOS `sandbox-exec`, OpenCode cannot start, git names its default branch `master`, and `15-settings-sandbox-keys` already fails on `origin/dev` (the unsigned page shows only the sign-in notice).
- [x] No Team accounts route, section, key or string remains; `/settings/team-accounts` is gone from the settings sidebar.
- [ ] Screenshots of the Models page (one account, two accounts, organization account as manager and as member) in light and dark, attached to the PR. Taken except the real member view, which needs a signed stack; a member view simulated by rewriting the account-sources read stands in. No PR yet.

Progress:

- Lane B's `requestConfirm` destructive flag landed first (`c706844`); lanes ran in worktrees off it.
- Lane C merged (`8636a3d`, `78c720c`, plus `7d4acbb` for the app server adapter's and usage contract's remaining wording). Remaining "team" words are identifiers and wire values: `payer.kind === "team"`, `teamKey`, `usage.teamSpend`, `TEAM_KEYS`, `teamKeyProvider`, `teamKeyRefused`, test file names.
- Lane A merged (`93f6ef4`, `f5fdba8`, `a56c6b7`, `5274dcf`): kit patch 0086, per-account checks, `requestConfirm` removals, `DrawerProviderConnect`, organization row Check/Remove, Team accounts deleted.
- Lane B merged (`a1a3728`, `872bf64`, `a6a217b`, `ad99ba8`, `f7f676d`): every destructive action outside accounts confirms through `requestConfirm`, including removing another agent's connection; forms on `FormDialog`/`FormDrawer`; new flow 18 (create task). The combined A+B+C tip is back under the app's line budget (107,601 of 107,760).
- Lane D merged (`c987ad7`, `fea26ce`): the settings placement is a derived state (loading, failed, no project, unavailable, ready) and the Models source a loading/failed/ready union; settings reads models through the same `readHarnessOptions` the composer's draft does, and nothing the Models tab reads starts a workspace. Desktop renderer closure 1403/36, measured.
- Final tip: `bun run check` (20/20, budget 107,702 of 107,760), app `typecheck`, `typecheck:e2e`, `bun run test` (974), root `typecheck`, `lint`, `test:architecture-ratchets` all pass. E2E (web and phone): every failure matches the unmodified `origin/dev` baseline in this container, except one `35-live-plugin-web` "swaps on save" phone run that missed the broken-build status before any changed step and passed on re-run.

Round 2 (owner review, 2026-10-18):

- Lane E (`c40b92f`, `b7f16c7`, `dfc70d8`, `3c0518a`): `requestConfirm` uses the dialog's own footer; form surfaces never clip a field or its focus ring, `FormDialog` grows to `min(100dvh - 32px, 600px)` and a scrolled form shows hairlines at the edges with more content; Create task and Create project are labelled forms.
- Lane F (`cf99916`, `8be8e89`): each account is its own row grouped as Saved in Claxedo, This computer's login and Organization, with its kind and a masked key (`key_•••••rsor`, from a `secret_hint` both credential stores keep at write time; the hosted D1 needs `ALTER TABLE hosted_provider_credentials ADD COLUMN secret_hint text;` before deploying), and "✓ This computer" and a "Cloud workspaces" checkbox on the row; the cloud choice is a popover that names only the harnesses sharing the account; the web shows nothing about a computer and the desktop nothing only the web needs.
- Lane G (`0b8eff5`, `280f88a`, `2b3eee2`, `9a28da2`), owner decision "always the static list": Claude Code, Codex and Cursor list models through `GET /api/claxedo/credentials/harness-models` (one server-core owner on the daemon and the hosted plane) with no project; a desktop on its CLI login lists Claude Code's plan form.
- Lane H (`b4e6af4`, `54e631d`): Pi lists its models from its provider catalog and OpenCode from one server-core projection with no project, and an OpenCode draft on an asleep cloud workspace gets its models from the control plane instead of asking to wake it; only ACP connections still need a project.
- Line budget set to the measured 107,990 total and 5,320 for Settings and accounts (`c8e6422`).
- Verified in this container with Node 24 (the repo's engine; Node 22 cannot parse OpenCode's `await using`): app check, typecheck, test, typecheck:e2e; root typecheck, lint, ratchets. E2E failures all match the unmodified `origin/dev` baseline here; flow 40's OpenCode tool name (`app_plugin_guide` vs `mcp__claxedo__app_plugin_guide`) and its claude/codex cases fail on `origin/dev` too and are outside this plan. Unrun here (signed stacks need macOS `sandbox-exec`): flow 53's web and member checks, flow 59's OpenCode asleep draft and Settings no-wake checks, flow 42 (Electron).
