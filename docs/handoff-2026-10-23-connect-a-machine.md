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

- **0.2.2 is published.** `claxedo-packages-release.yml` published all ten packages from dev 17c2807bbd on
  2026-10-24 (run 40056325061); npm's `latest` for `@claxedo/cli` is 0.2.2, which `MINIMUM_CONNECT_CLI_VERSION`
  accepts.
- **The control-plane schema grows.** `0001_baseline.sql` (pinned by `control-plane-schema.test.ts`) adds, to
  `host_enrollments`: `approval_requested_at`, `revoked_reason`, `machine_json`, `blocked_json`; to
  `host_invitations`: `kind` (default `'preapproved'`), `pairing_progress_json`, `pairing_request_json`,
  `pairing_decision`, `pairing_decided_at`, `pairing_workspace_id`, `first_workspace_id`; and the index
  `host_invitations_by_pairing_code`. Staging's control-plane D1 got them on 2026-10-24 by eleven `ALTER TABLE … ADD
  COLUMN` statements and the `CREATE INDEX`, each written as the baseline spells it and in its order, which keeps
  every row: SQLite writes an added column into the stored `CREATE TABLE` text just after the last column, so the
  deploy's `requireControlPlaneBaseline` admits the result as the current baseline. That was rehearsed first on the
  live schema's own text with the deploy's check, and the deploy then admitted it. Production needs the same
  statements before it runs this Worker.

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
- **Live** (Windows passed on 2026-10-24; see below):
  1. On a fresh Ubuntu, macOS and Windows box, paste the drawer's command.
  2. Approve the card, then time paste → card → ready. That is C0 and the definition of done.
  3. Then run the server command from cloud-init on a new VM.
  4. Then connect over SSH from the macOS desktop app.

## Not proven, or open

- **C0 and the definition of done:** passed on Windows (below); fresh Ubuntu and macOS boxes are still to run.
- **Windows:** `connect.ps1` installing without admin. Every run was as Administrator; creating a standard user on
  the box was refused to the agent.
- **A pairing code is counted from when the drawer mints it**, and the install's progress report does not extend it,
  so a machine whose install outlasts 15 minutes is refused `pairing_expired` at redeem. The registry install took
  3 minutes on a c7i.2xlarge; a smaller box with Defender scanning each unpacked file is unmeasured against npm.
- **A connected machine has no harness of its own.** The connect script installs none, and the runtime launches the
  machine's own `claude`, so a fresh machine's first look at Claude Code's models answers "Claude Code is not
  installed or not on PATH" with the npm command. Nothing before the model picker tells the person.
- **The approval card's "asked 2 seconds ago"** read the same 35 s later; it may not tick.
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
- **Pi on Windows:** "stopping a Pi turn mid-bash kills the command's process" (`harness/src/conformance/pi.test.ts`,
  a real-CLI suite Windows CI skips) fails three runs of three on Windows Server 2025: the command's background
  `sleep` outlives the Stop. Likely from dev's 4818d444db, which lets a process a Pi command leaves running outlive
  the command on Windows. `docs/release/windows-real-cli-suites.md` makes this suite a Windows release gate.
- **The e2e harness's default ports (46100–46199, `packages/harness/e2e/harness/ports.ts`) sit inside Linux's
  ephemeral range (32768–60999).** With the server suite running beside it, two signed tests failed in setup with
  `EADDRINUSE` on 127.0.0.1:46104 and :46102, then passed alone. Moving the default below 32768 means finding
  everywhere the app's e2e build reads `PORT_RANGE`.

## Windows run on the merged tree (2026-10-24)

The branch merged with dev's Windows work (dev's 1cf863c0 and this branch's fix of the same harness-2 hang: the
branch's is kept), on Windows Server 2025:

- **Full suite**, as `script/cbx-ci-windows.ps1`'s unit lane runs it (`build:packages`, `test:opencode-node`, then
  `bun turbo test --concurrency=1 --continue` with the real-CLI suites on), on a c7i.2xlarge: 2 h 2 min. Every
  package passed but:
  - desktop: `readSshTarget` joined `~` with a `/` (fixed in `ssh.ts`), and the local-server closure walk read
    files encoded, 9.0 s against bun's 5 s timeout (fixed);
  - host-serving: the two clone tests read README.md as CRLF under Git for Windows' `core.autocrlf=true` (the
    fixture now commits `* -text`);
  - harness: the Pi stop test above; server: the documents backend's "direct writer races the archive claim"
    failed with `EPERM` (one run of three alone); channels: the Chat SDK smoke test ran past 5 s cold and passes
    alone in 1–6 s. These three predate the branch.
  - workspace-runtime: `real-spawn.test.ts`'s neighbor terminal never echoed `echo neighbor-%OS%`, because OpenSSH
    sets `SHELL` to PowerShell and the PTY prefers `SHELL` to `COMSPEC`; with `SHELL` unset it passes two runs of
    two, as do the Pi native routes the failure had kept from running. A rig effect, not a defect.
  - The CLI's 38 skips are the `install.sh` and `install.ps1` tests, which need a POSIX shell or pwsh.
- **`connect.ps1` on a fresh box** (t3.large, no Node, no Git, Defender on), with the merged tree's packed 0.2.2 and
  a staging invitation:
  - It failed before installing anything: `Install-Node` moved Node into a folder whose parent no step had made
    (fixed). It then installed Node v24.22.1 in 49 s and named Git for Windows as missing, in one line.
  - After an 18-minute npm install it could not run the CLI: npm's summary line went into `Install-Cli`'s return
    value (fixed, with a test under pwsh that fails without the fix).
  - Fixed, it installed and enrolled in one run (1,105 s, npm 18 min of it), registered `ClaxedoConnect` and said
    it would start at the next logon. Run again with the CLI installed, it reused 0.2.2 and enrolled in 9 s.
  - The task's own wrapper served (owner accounts delivered), assign answered in 3.3 s, a terminal opened and
    answered 0.6 s after its socket, and a revoke made the wrapper exit 78 within 2 s and disabled the task.
  - Staging runs dev's Worker, so the machine report (C6) answered 404 and the invitation's name lost to the
    hostname, as expected there.

## Live end to end on staging (2026-10-24)

Staging ran dev 17c2807bbd, then 270c96bcb8, with npm's 0.2.2, against a fresh Windows Server 2025 c7i.2xlarge
(Git for Windows installed first, as the script asks; no Node; Defender on), driven through the web app signed in as
the owner:

- **Settings → Machines → Connect a machine…** minted a code; its Windows tab's command, pasted into Windows
  PowerShell 5.1 in `C:\work\demo`, put "Installing on EC2AMAZ-8GLRGQ2…" in the drawer within a second.
- **The first paste stopped at step 3/4:** npm refused `Invalid tag name "@" of package "@"`. With one package and no
  `CLAXEDO_CLI_TARBALL`, `$packages` was a string and `@packages` splatted it one character at a time; every earlier
  Windows run had set the tarball seam. Fixed in 270c96bcb8, with a registry-path test under pwsh that fails without
  it. The run below used the served script with that fix applied; staging now serves the same code byte for byte.
- **Paste to "Approve this machine": 170 s**, nearly all of it `@claxedo/cli@latest` (564 packages, 163 s). Node
  v24.22.1 was already there: the first paste had installed it in 27 s.
  The card showed the hostname, "Windows Server 2025 Datacenter · x64 · IN" and `C:\work\demo`; Approve made it
  "Approved; waiting for EC2AMAZ-8GLRGQ2 to connect…", and the machine's row said "Its service starts when its user
  next logs on". The paste's own process ended there: over SSH the `ClaxedoConnect` task stays Ready.
- **At a real logon** (auto-logon, then a reboot) Administrator's console session began 77 s after the reboot, the task
  ran, and the row turned Online and the drawer "demo on EC2AMAZ-8GLRGQ2 is ready" 2 min 2 s after it.
- **A session from the app:** the composer's project picker offered "demo"; Claude Code's models failed until
  `npm install -g @anthropic-ai/claude-code` (16 s) and loaded 3 s after Retry. A prompt sent with Default ran
  `hostname; node --version; git --version; printf 'e2e ok' > hello.txt; ls -la` on the machine and answered in 8 s;
  `C:\work\demo\hello.txt` held exactly `e2e ok`.

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
