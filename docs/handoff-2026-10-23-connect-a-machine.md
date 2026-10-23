# Handoff — 2026-10-23 (evening): connecting a machine

`claude/zealous-cori-ntmcvv` holds the connecting-a-machine work, built in one session with five parallel lanes
(C5, C6/C7, C8, C9 and the install measurement) and merged with `origin/dev` at `1cb195e`. It is pushed, not merged
into dev, and has no pull request. Every lane is merged and no worktree holds unmerged work.

The plan, with a checkbox and a progress note per item, is
[`docs/plans/2026-10-23-002-feat-connect-a-machine-ux-plan.md`](plans/2026-10-23-002-feat-connect-a-machine-ux-plan.md)
(C0–C9). The earlier handoff of the same day, [`docs/handoff-2026-10-23.md`](handoff-2026-10-23.md), still describes
dev and staging.

## What landed on this branch

| Area | What | Where |
|---|---|---|
| Pairing (C1, C3) | **Connect a machine…** mints a single-use code valid for 15 min. The control plane serves `/api/claxedo/connect` and `connect.ps1` with its own origin, the accepted CLI version and an `x-claxedo-script-sha256` header. `claxedo connect --pair CODE` enrolls a machine that waits, serving nothing, until its owner approves it in the app; only the person who minted the code sees the request. Deny makes the machine exit 78 | `@claxedo/account-contract/machine`, `routes/hosted/host-pairing.ts`, `routes/hosted/connect-scripts.ts`, D1 `host-pairing-authority.ts`, host-connector pairing, `packages/cli/src/connect/pair.ts`, app `settings/pairing.ts`, `settings/view/machine-connect.tsx` |
| Live machine state (C4) | `machine.changed` goes to the owner's live-sync rooms on every pairing move, acquire and serving change; the app maps it to `machinesChanged`, so the drawer, Machines and Projects follow without polling | `server-core` bus and `event-visibility.ts`, `workspace/host-changed-notice.ts`, app `server/wire/frames.ts`, `server/freshness.ts` |
| Failures (C6) | A machine reports its CLI version, system and one blocking reason (`linger_off`, `user_manager_unreachable`, `waiting_for_logon`, `desktop_daemon`, `stopped`) with the fix command; Details and the list say "Offline · last seen … · <cause>". Re-running the command on a connected, removed or foreign-plane machine asks before replacing it, so nobody needs `--reset` | `POST /api/claxedo/host/enrollments/report`, `pair.ts` |
| Managing (C7) | Details renames a machine, changes its roots (confirming what each retires), removes it, and shows the CLI version with "Update available" below `MINIMUM_CONNECT_CLI_VERSION` | `machines.rename`, `machines.setRoots`, app `settings/view/machine-*.tsx` |
| Servers without a browser (C8) | The drawer mints a pre-approved, single-use invitation for one folder, as a cloud-init snippet or one command; `install.sh` enables lingering where it may | `machines.invite`, `settings/view/server-connect.tsx`, `packages/cli/install.sh` |
| SSH from the desktop (C9) | The desktop's drawer connects a machine it reaches over SSH: Electron main checks the host with the person's own ssh config, asks them to trust an unknown key, fetches the connect script, runs it only when it hashes to the plane's sha256, and streams it to `sh -s -- <code>` | `packages/claxedo-desktop/src/main/ssh-connect/`, app `settings/ssh-connect.ts`, `settings/view/machine-ssh.tsx` |
| Projects on a machine (C5) | A grant the plane mints per request carries each host-management call to the owner's machine. The create-project form picks a folder on a machine from its own folder dialog, clones a repository onto it (through the egress broker when one of the person's connections reads it, so no code-host token reaches the machine), and the Where chip makes a new worktree there. Where it runs opens a machine's folder, clones a gone one back and removes one; clone and worktree code is one implementation in `server-core` `hosts/machine/` | `routes/hosted/host-machines.ts`, `workspace/machine-management.ts`, egress broker `machineRepositoryClone`, app `projects/folder-places.ts`, `server/machine-projects.ts` |
| Release | helpers and cli 0.2.2, runtime track 0.10.2 (dev made the same bump); the release dry run passes for all 10 packages | `script/PUBLISH-ORDER.md` |

## Proof on this branch

- **At the last lane merge (`f7f542e`):**
  - The full server suite passed: 312 files, 2,864 tests, 1 skipped.
  - App flows `02-projects-machine`, `02-projects-local`, `02-worktree-branches`, `15-settings-machines` and
    `15-settings-connect-machine` ran on web and phone, 46 tests in all. 44 passed in the run. Two failed in setup
    with `EADDRINUSE` while the server suite ran beside them, and passed alone.
  - The app's `bun run check` (20 steps), `typecheck`, `typecheck:e2e` and 1,354 unit tests passed.
  - Typechecks passed for server, server-core, local-server, cli, host-serving, desktop, host-connector,
    workspace-runtime and account-contract, and `bun run test:architecture-ratchets` passed.
- **After merging dev (`6cbc1f8`):**
  - The CLI's connect and doctor tests (89), the Claude probe tests (2) and host-serving's direct-listener tests (8)
    passed.
  - Typechecks of cli, harness, host-serving and workspace-runtime and the ratchets passed.
  - The release dry run passed for all 10 packages.
  - The flows and the full server suite were not rerun after this merge.

## Before anyone pairs a real machine

- **Publish 0.2.2.** The connect script reuses an installed CLI only at `MINIMUM_CONNECT_CLI_VERSION` (0.2.2) or
  later and otherwise installs npm's `latest`, which is 0.2.1 and does not know `--pair`. Every proof here ran the CLI
  from source. Publish through `claxedo-packages-release.yml` (helpers, then runtime, then cli), never by hand, and
  not while dev is being merged into.
- **The control-plane schema grows.** `0001_baseline.sql` (pinned by `control-plane-schema.test.ts`) adds, to
  `host_enrollments`: `approval_requested_at`, `revoked_reason`, `machine_json`, `blocked_json`; to
  `host_invitations`: `kind` (default `'preapproved'`), `pairing_progress_json`, `pairing_request_json`,
  `pairing_decision`, `pairing_decided_at`, `pairing_workspace_id`, `first_workspace_id`; and the index
  `host_invitations_by_pairing_code`. A deployed D1 needs these columns, by `ALTER TABLE … ADD COLUMN` or a reset as
  staging had, before this branch's Worker serves it.

## Decisions waiting on the owner

1. **Install weight (decision 2).** The measurements are in the plan's C2. In short: the full install is 568 packages
   and about 824 MB; harness code is 94% of it; fetching each harness on first use would cost OpenCode 64 s, Pi 15 s
   and Claude 9 s at its first session. Dev's `850a3a1d` already drops the 230 MB Claude Code binary the runtime never
   ran. The full install stays until you choose.
2. **C8:** `app.sandbox-credential-scope.test.ts` now lets `machines.invite` reach `/host/invitations` (a person's own
   invitation, checked by `requireWriter`); an invitation's name now wins over the machine's hostname; the
   invitation's folder becomes the first workspace through `first_workspace_id`.
3. **C5's authority rule.** A local worktree filed into a named project takes that project's repository key
   (`creationRepositoryKey` in D1 `workspace-authority.ts`), scoped to the caller's organization. Without it a
   worktree's assignment failed as a race. Cloud workspaces are unchanged.

## What to test, and how

Run every command with Node 24 and bun 1.3.14 on `PATH`.

- **App flows** (from `packages/claxedo-app`):
  `bun run e2e -- e2e/flows/15-settings-machines.spec.ts e2e/flows/15-settings-connect-machine.spec.ts e2e/flows/02-projects-machine.spec.ts --project=web`, then
  `--project=phone`. These run the real CLI from source against the signed stack. They need Docker, an
  e2e runtime image (`CLAXEDO_E2E_RUNTIME_IMAGE`), and, for the local project specs, git's default branch `main`.
- **Server:** `node ../../script/test-home/run.mjs node ./node_modules/vitest/vitest.mjs run` in
  `packages/claxedo-server`; the sandbox credential-scope sweep and `routes-are-routes.test.ts` are the two that new
  hosted routes trip.
- **Release:** `bun run --cwd packages/claxedo-server release:packages --track all --dry-run`.
- **Live, once 0.2.2 is published:**
  1. On a fresh Ubuntu, macOS and Windows box, paste the drawer's command.
  2. Approve the card, then time paste → card → ready. That is C0 and the definition of done.
  3. Then run the server command from cloud-init on a new VM.
  4. Then connect over SSH from the macOS desktop app.

## Not proven, or open

- **C0 and the definition of done:** need fresh Ubuntu, macOS and Windows boxes against staging.
- **Windows:** `connect.ps1` installing without admin, the paste-to-approval time, and the 29-minute install (left
  as asked; dev's measurements are under C0).
- **Lingering** is tested against a fake `loginctl` only.
- **SSH (C9)** ran live under xvfb against a local sshd, not on macOS or Windows. It has no committed e2e flow: the
  harness runs no sshd, and Playwright's Electron launch forces a password store a signed Linux desktop refuses.
- **C5:**
  - A private GitHub clone through the broker is covered by broker tests and a real git clone through a loopback
    broker, not live: the scripted GitHub serves no git.
  - Parity is open for editing a project (the hosted plane has no project configuration route) and for worktree
    cases that run a turn on the machine (no scripted ACP connection there).
  - The desktop is not yet a client of it.
  - A machine whose only shared folder is gone cannot be reached for host management.
- **Re-pairing a machine connected to another control plane** has no test of its own.
- **Accessibility:** the Create project dialog's select options sit under an `aria-hidden` portal, so screen readers
  and role queries cannot reach them; keyboard selection works.
- **Windows `unit (windows, harness-2)`** still hangs on dev before the Claude probe spawns. See the earlier
  handoff.
- **The e2e harness's default ports (46100–46199, `packages/harness/e2e/harness/ports.ts`) sit inside Linux's
  ephemeral range (32768–60999).** With the server suite running beside it, two signed tests failed in setup with
  `EADDRINUSE` on 127.0.0.1:46104 and :46102, then passed alone. Moving the default below 32768 means finding
  everywhere the app's e2e build reads `PORT_RANGE`.

## Working rules this stretch taught

- **Never change the tree under a running long suite.** A server run that straddled two merges failed 17 suites
  that each passed alone. Merge in a spare worktree and fast-forward afterwards.
- **`routes/` holds routers only** (`routes-are-routes.test.ts`). Put request helpers and generated tables in the
  domain.
- **Every new hosted route must pass the sandbox credential-scope sweep.** A machine-only route goes in
  `UNAVAILABLE_ROUTES`; a route that reads no scope name goes in `NAME_FREE_ROUTES`. Never widen a list to get green.
- **After merging lanes, re-measure everything they counted:**
  - the app budget;
  - the renderer closure;
  - the Worker pins, including both Agent Plugins entries, which mount the same hosted routes;
  - the 800-line cap, which two lanes adding operations to one file crossed together.
- **The release dry run's `verify:publish` checks the README's export list.** An export added without it blocks
  the release.
