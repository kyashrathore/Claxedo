# Connecting a machine: one paste, one click

This plan makes adding your own persistent machine (a laptop, a home or office desktop, a cloud VM you keep
running) to Claxedo the easiest step in the product: from **Connect a machine…** in the web or desktop app to the
first session running in a folder on that machine, with one command pasted on the machine and every other step in
the app. It covers living with the machine afterwards too: its state, its failures and how to recover, its folders,
and removing it.

A connected machine is not a cloud workspace:

| | Connected machine (this plan) | Cloud workspace (`claxedo-app/src/cloud`) |
|---|---|---|
| Whose computer | One the person already runs and keeps | A sandbox Claxedo creates on the organization's provider key |
| Lifecycle | The person's: Claxedo never starts or stops it | The server's: provisioning, starting, ready, stopping, stopped ("Asleep"), failed |
| Files | Folders that already exist on it, assigned as they are | The project's repository cloned in; `.claxedo/setup.sh` and `.claxedo/start.sh` run; stopped workspaces resume from a checkpoint |
| Tools and logins | Whatever the machine has: its CLIs, SSH keys, Docker, GPUs | The workspace image and setup script |
| How Claxedo reaches it | The machine dials out (`claxedo connect`) to the relay | The control plane drives the provider's API |
| State in the app | Online, Offline (last seen), Paused | The lifecycle states above |
| Model accounts | The hosted broker, or the owner's desktop on the same LAN (machine-connection plan, W4) | Kept outside the VM, through the control plane |

How fast and safe a connected machine is once it serves (routes, access checks, model accounts) stays with
[Machine connection](./2026-10-23-001-feat-machine-connection-plan.md). Its W5 keeps `claxedo doctor` and the
service's PATH; W5's Windows installer, the 29-minute Windows install and adding a machine over SSH move here.

The bar: Tailscale's "install, open a link, approve" and Vercel's `vercel link`. Nobody copies a token into a file,
needs a second computer with the CLI signed in, or types a path from memory.

## 0. Decisions

Decided by the owner on 2026-10-23:

- **Connecting is the focus.** The web app's direct LAN route (W7 in the machine-connection plan) is parked: it
  needs per-machine certificates, a domain of our own and DNS infrastructure, which cost more than they return now.
  The web keeps the relay.
- **The first folder is the one the command runs in.** The machine shares that folder and nothing wider. The
  terminal never lists folders to choose from.
- **A connected machine creates projects as this computer does.** The create-project form, the folder dialog,
  cloning a repository and new worktrees work on a connected machine as they do on the desktop's own machine (C5).
  The machine's roots stop being something a person types: they are the record of the folders the owner has chosen.

Open, for the owner (each blocks only its own workstream):

1. **How a machine pairs (C1, C3).**
   - **A (recommended):** the app shows one command carrying a single-use pairing code; the machine redeems it and
     waits; the person approves it in the app, seeing its hostname, OS and country, before it serves anything.
   - **B:** the machine prints a short code (as `claxedo login` does today) and the person types it into the app.
   - **C:** the app's command enrolls at once with no approval, as today's invitation does, just minted by the
     app.

   A pastes once and clicks once, and a leaked command does nothing without the click. B needs typing. C is
   fastest, but anyone who sees the command within its lifetime can enroll their own machine into the account.
2. **Install weight (C2).** The connector installs the full runtime: every harness SDK, the embedded OpenCode engine
   and a 224 MB Claude Code binary. Fetch each harness's payload the first time it is used, or keep the full
   install and accept its time? C2's measurement says what each choice saves.

## 1. Where it stands

Observed on `origin/dev` cb9b7e2a6e, 2026-10-23.

**A. The app.** Settings → Machines → **Connect a machine…** opens `ConnectMachineDrawer`
(`claxedo-app/src/settings/view/machine-connect.tsx`). The composer's Where chip, Projects → Where it runs and
onboarding open the same drawer through `useConnectMachine`. The drawer has two steps:

1. "The computer you are sitting at": install the desktop app and sign in.
2. "Another machine you own": a name field fills in two commands, `claxedo host invite --name <name> --root ~/code`
   ("on a computer where the Claxedo app is signed in") and `claxedo connect --token-file ./invite.txt
   --install-service` ("on the machine you are adding"), then **I've run it**.

**B. Minting the invitation, on a second computer.** `claxedo host invite` needs the CLI's credentials
(`requireAccessToken` reads `~/.claxedo/credentials.json`, written by `claxedo login`'s device code or by a signed-in
desktop app through `cli-credential-file.ts`). It posts `{ displayName, scope.allowed_roots, expiresInMs }` to
`/api/claxedo/host/invitations` and prints the token once (`inviteOutput`). The invitation lasts 1 h by default and is
single use. Roots are required: "an invitation with no roots can serve nothing".

**C. Installing on the machine.** Linux and macOS: `install.sh` from `raw.githubusercontent.com/.../packages/cli/
install.sh` uses Node 24 or downloads it (sha256 checked), installs `@claxedo/cli` with npm's install scripts off,
then runs `install-opencode-node.mjs`. Windows has no installer; the CLI README gives two commands to run by hand.
The drawer has no install step at all.

**D. Connecting.** `claxedo connect --token-file F --install-service` (`cli/src/commands/connect.ts`) refuses beside
a live desktop daemon (exit 78), redeems the invitation (`redeemInvitation`), removes the token file, writes a
systemd user unit, LaunchAgent or scheduled task, and starts it. On Linux without `loginctl enable-linger` the unit
is written but not started (exit 78). Every message lands in the machine's terminal only.

**E. Waiting in the app.** **I've run it** runs `createConnectWait` (`settings/machines.ts`): one `machines.list`
recheck, then "Waiting for <name>…" until the person presses **Check again**. The machines query is refreshed by
placement events (`placementsChanged`, `cloudWorkspaceChanged`, `streamGap` in `server/freshness.ts`). No event
names an enrollment or an online change; C4 verifies what a new or departed machine does to the list today.

**F. Getting a folder to work in.** A new machine serves nothing until a folder is assigned, and only `claxedo host
assign --machine <name> <dir>` from a signed-in CLI does that (`/api/workspace/:id/host-assignment`). The app's
hosted operations for machines are `machines.list`, `machines.pause`, `machines.resume` and `machines.remove`
(`account-contract/src/hosted-operations.ts`); none assigns, scopes or invites. The machine acks an assignment
2.5–3.8 s later through the `host.changed` ring.

**Measured:**

| Step | Today |
|---|---|
| Install, fresh Ubuntu 24.04, from npm | 182 s |
| Install, macOS | 2–3 min |
| Install, one Windows Server 2025 run (local packs) | 29 min, cause unknown |
| What `@claxedo/cli@latest` installs (macOS arm64, 2026-10-23) | 568 packages, ~56,000 files, 939 MB; the largest is `claude-agent-sdk-darwin-arm64` at 224 MB |
| Assign → the machine serves it | 2.5–3.8 s |
| Terminal mint → first output | 5.0–5.3 s |

**Defects in today's flow:**

1. The drawer's invite command prints the token to the terminal; its connect command reads `./invite.txt`, which
   nobody wrote.
2. `--root ~/code` is expanded by the laptop's shell to the *laptop's* home, which is the wrong path on any machine
   whose home differs, and in PowerShell it reaches the CLI unexpanded and is refused ("--root must be an absolute
   path").
3. A web-only person has no signed-in CLI. Connecting takes five steps across two computers: install the CLI
   somewhere, `claxedo login`, invite, move the token, connect.
4. Nothing says how to install, and Windows has no installer.
5. Once connected there is nothing to work in until a CLI assigns a folder.
6. The wait checks once and then needs clicks.
7. Failures (an expired invitation, no linger, the desktop daemon conflict, a stopped service) are explained only in
   the machine's terminal; the app shows "Offline" or nothing.
8. Connecting a machine again after a removal or a reset needs `claxedo connect --reset`, which only the CLI's help
   mentions.

## 2. Target

Proposed. Every step except the paste happens in the app, and the app follows the machine live.

1. **Connect a machine…** The drawer opens on the command for the person's guess of the machine's OS, with tabs
   for the others. The code inside it is minted when the drawer opens and lives 15 minutes.

   ```
   Connect a machine
     Run this on the machine:
       [macOS / Linux]  Windows
       curl -fsSL https://app.claxedo.com/connect | sh -s -- K7QM4PXD   [copy]

     ◌ Waiting for the command…                          code valid 14:52
   ```
2. **The machine installs and pairs.** The drawer shows each step as the machine reports it: "Installing on
   build-box… → Waiting for your approval".
3. **Approve.** The person sees what is asking to join and the folder the command ran in, which is what it will
   share:

   ```
   ┌ Approve build-box? ─────────────────────────────────────────────┐
   │ Ubuntu 24.04 · x64 · India · asked 8 s ago                      │
   │ Name      [ build-box                    ]                      │
   │ Folder    /home/ubuntu/code/app   (where you ran the command)   │
   │                                  [ Deny ]   [ Approve ]         │
   └─────────────────────────────────────────────────────────────────┘
   ```
4. **Start working.** "app on build-box is ready" with **New session**; the composer opens with that placement
   chosen. The machine's terminal says the same in one line.
5. **More projects, as on this computer.** **Create project…** offers "Folder on build-box" with the same folder
   dialog this computer uses, and a repository (URL or connected code host) cloned onto build-box. The Where chip
   offers "New worktree on build-box". Running the command again in another folder on that machine also adds that
   folder, after the person confirms it in the app.

From then on, Settings → Machines shows each machine's state in words, and any failure the machine can report
appears there in one line with its fix. A server with no browser at hand (AWS user data, cloud-init) gets a
pre-approved command from the same drawer.

## 3. Workstreams

Each workstream proves its behaviour live before its broad suites run (AGENTS.md, "Validation cadence"): build, run
it through its real entrypoint against staging or a real machine with the logs tailed, cover every case it claims,
and only then run the affected e2e flows at merge.

### C0 — Baseline

- [ ] Time and screen-record today's journey from **Connect a machine…** to a first session's first output, on
  fresh Ubuntu 24.04, macOS and Windows boxes against staging, through the published CLI. Each step is timed
  separately: install, invite, connect, first folder, first output. Progress: blocked here: it needs fresh Ubuntu, macOS and Windows boxes against staging.
- [ ] The 29-minute Windows install is reproduced from npm and explained (`npm install --timing --loglevel http`,
  with and without a Defender exclusion on the prefix), or shown not to recur from the registry. Moved from W5.
  Progress:

### C1 — The app mints the command

No second computer, no token file, no roots typed on a laptop.

- [x] A hosted operation (`machines.pair`) mints a pairing invitation for the signed-in person: single use, 15 min,
  with no roots (the machine names its folder when it redeems; C3). The invitation route and store gain that kind; `claxedo host invite` keeps today's
  pre-approved kind for C8. Progress: `host_invitations.kind` (`preapproved` | `pairing`), `D1HostPairingAuthority`,
  `POST /api/claxedo/host/pairings`; the invitation redeem refuses a pairing row (`invitation_invalid`).
- [ ] The control plane serves `connect` (POSIX shell) and `connect.ps1` from its own origin, with its own URL
  inside, so a staging command connects to staging and no `CLAXEDO_CONTROL_PLANE_URL` has to be set by hand. Each
  installs the CLI as C2 describes and runs `claxedo connect --pair <code> --install-service`. Progress: done
  (`routes/hosted/connect-scripts.ts` over a generated mirror of `install.sh` / `install.ps1`, checked by a test).
- [x] The drawer shows the command for the guessed OS, tabs for the others, a copy button, the code's remaining
  time, and mints a fresh code when the old one expires while the drawer is open. Progress: done; e2e flow 15 on web
  and phone.
- [x] The drawer's two-command step and its `~/code` root are removed. Progress: done.
- [ ] Refusals, each one line in the app and on the machine: the code expired, the code was already used, the code
  belongs to another control plane, and the person signed out before the machine redeemed it. Progress: done
  (`PAIRING_REFUSALS` on the machine; signing out cancels unused codes; a code from another plane is not valid
  there). The app shows no refusal of its own: a code it minted is either redeemed or runs out and is replaced.

### C2 — Install in one step, on every OS, quickly

- [x] `connect` reuses an installed CLI whose version the control plane accepts, else installs as `install.sh` does
  today; it prints numbered steps and one line per failure. `install.sh` is that script's install half, not a
  second copy. Progress: done; `install.sh` is the one script, served with the plane's URL and its accepted version
  (`MINIMUM_CONNECT_CLI_VERSION`) set at its top.
- [ ] `connect.ps1` installs on Windows without admin: Node 24 if missing (checksum verified), the CLI with install
  scripts off, the runtime's setup, Git for Windows found or named as the one missing prerequisite. Proven on a
  fresh Windows 11 and Windows Server 2025 from npm. Moved from W5. Progress: `install.ps1` written and served as
  `connect.ps1`; it parses under PowerShell 7. Not yet run on Windows: no Windows box was available.
- [x] Measure what the connector loads to enroll and serve against what each harness loads, and report the install
  time and size each option of decision 2 would give, before building one. Progress: measured on Linux x64 against
  `@claxedo/cli@0.2.1`: the full install is 568 packages, 823.7 MB, 82.4 s cold; harness code is 772.3 MB of it, and
  240.3 MB is the Claude Agent SDK's native binary, which the runtime never runs. Core only would be 51.5 MB in 4.9 s
  but needs the eight statically imported harness packages made lazy; deferring only today's lazy imports gives
  202.0 MB in 40.2 s. First-use fetches: OpenCode 64.2 s, Pi 14.5 s, Claude 9.4 s, Cursor 2.5 s. Decision 2 is still
  the owner's; the full install stays.
- [ ] On a fresh box, the paste-to-approval-card time is ≤ 60 s on Linux and macOS and ≤ 3 min on Windows. These
  targets need decision 2; record the measured time against each. Progress: blocked on decision 2 and on fresh
  Linux, macOS and Windows boxes against staging.

### C3 — Approval in the app

- [x] A redeemed pairing creates an enrollment awaiting approval, which serves nothing and holds no assignment.
  The machine reports its hostname, OS, architecture, CLI version and the folder the command ran in (its canonical
  path, as `--root` records one today); the control plane adds the request's country. Progress: done
  (`approval_requested_at`, `machine_json`; the verifier refuses a waiting machine everything but its doorbell and
  its own pairing read).
- [x] The drawer, when open, shows the approval card. Otherwise the request appears at the top of Settings →
  Machines, and the machine prints the app link to it. Progress: done; e2e flow 15 covers both.
- [ ] **Approve** sets the name, makes that folder the machine's one root and assigns it as the first workspace,
  and the machine starts serving it on its next ring. When the folder is the home directory or the filesystem root,
  the card says so in one line before the person approves. **Deny**, or 15 minutes without an answer, revokes it:
  the machine exits 78 with one line saying why, and the service does not restart into it. Progress: done; the
  approval assigns the folder as a workspace named after it; e2e flow 15 covers approve and deny, and the
  connector and CLI tests cover expiry.
- [ ] Only the person who minted the code can approve it. Another member of the organization never sees the
  request. Progress: done (`ownedPairing`; D1 test "only the person who minted a code sees or answers it").

### C4 — The app follows the machine live

- [x] Verify what today's machines list does when a machine enrolls, goes online, goes offline, is paused or is
  removed while the app is open, and record it here. Progress: before this work only the placement events
  (`placementsChanged`, `cloudWorkspaceChanged`, `streamGap`) refreshed it, and no event named a machine, so the list
  changed only on the person's own action or the next reload.
- [x] The drawer moves through "Waiting for the command → Installing on <name> → Waiting for your approval →
  Connected → Ready" with no button. The machine reports install progress against its pairing code before it
  enrolls. Progress: done (`POST /api/claxedo/host/pairings/progress` from the connect script).
- [ ] Settings → Machines, the Where chip and Projects reflect a machine enrolling, coming online, going offline,
  being paused and being removed within 2 s, through one app-facing event beside the placement events, not
  through polling. Progress: `machine.changed`, sent to each organization room of the owner on a pairing's moves,
  on an acquire, on a beat that changes what the machine serves, and on every owner-side change; the app's
  `machinesChanged` refreshes the machines, the pairings and the account catalog. A machine that goes away without
  a last beat (a crash, a lost network) shows offline at the next read, after its lease lapses, not within 2 s.

### C5 — Projects on a connected machine, as on this computer

Today a project's source is a repository URL, a repository from a connected code host, or a folder, and the folder
is offered only on the machine the app's server runs on (`capabilities().servingMachine`): "a folder on another
machine is added on that machine, because no route sends a new project to a connected machine"
(`claxedo-app/src/projects/README.md`). The folder dialog (`view/select-directory.tsx`: Search folders, Recent
projects, Tab completes, Enter picks) reads `queries.folders.paths()`, `queries.folders.children(directory)` and
`server.folders.search` from that same server. "New worktree on <machine>" is offered only for the serving machine,
since worktrees are the local server's own route. This workstream gives a connected machine each of those, and
takes over [Remote machine connection](./2026-09-14-003-feat-connect-implementation-plan.md)'s deferred P5.3
(machines in the create-project form) and P5b (host folder operations).

- [x] **The boundary.** A workspace token authorizes one workspace, not the machine, so an operation on the
  machine as a whole (listing folders, adding a folder, cloning, a new worktree as its own checkout) runs on a
  host-management grant. The control plane mints it for (person, enrollment, operation, destination, expiry), only
  to the machine's owner; the machine verifies it against the control plane's key, and it is distinct from the
  relay's proof. Such an operation creates new workspace rows scoped to that enrollment and never rewrites an
  existing one (the rule P3.3 set). Progress: done 2026-10-23 (lane C5). The grant is a member of the pass family
  (`claxedo-server-core/src/platform/auth/host-management-grant.ts`, audience `claxedo-host-management`, one
  operation of `folders.read`, `clone`, `worktree`, a destination, the host, one minute). The plane mints one per
  request, only after `ownedMachine` finds the caller's own unpaused, live enrollment serving a folder, and carries
  it as `x-claxedo-host-grant` through the relay as the caller under that folder (`workspace/machine-management.ts`).
  The machine (`claxedo-host-serving/src/host-management.ts`, a route contribution of every runtime `claxedo connect`
  serves) needs the relay's proof naming the workspace owner and the grant verified against the plane's JWKS for
  its own enrollment and host, that person, operation and destination, and spends each grant once. A folder the
  owner picks becomes a new workspace on that enrollment's organization through `assignWorkspaceHost` with an id
  the app mints, so none is re-pointed. The desktop daemon does not mount it yet (no app surface enables its remote
  access).
- [x] **Folder on <machine>.** The create-project form offers "Folder on <name>" for each online connected machine
  the person owns. The same folder dialog opens with that machine's folders (its paths, children and search,
  answered by the machine under the grant; `~` is the machine's home). Picking a folder adds it to the machine's
  roots and assigns it, and it becomes a project the way `claxedo host assign` makes one today. Progress: done
  2026-10-23 (lane C5). Folder places are this computer and each of the person's online, unpaused machines that
  serve a folder (`projects/folder-places.ts`); with more than one a Machine select picks it. The dialog reads
  through `machines.folders` (`POST /api/claxedo/host/machines/:enrollmentId/folders`: home, one folder's
  subfolders, or a search under one), and the pick is `machines.assign`, the route `claxedo host assign` uses
  (`/api/workspace/:id/host-assignment`) with `addRoot`. Live: `02-projects-machine` pairs a real `claxedo connect
  --pair` machine on the signed stack, picks `~/folders/al…` in the machine's dialog, and reads the new workspace back
  from the catalog and the machine's served set, on web and phone; red with the machine's host management unmounted
  (no folders listed).
- [ ] **Clone onto <machine>.** A repository URL or a code-host repository is cloned onto the chosen connected
  machine, into a folder the person can change (by default beside the machine's first shared folder). The clone's
  credential is brokered (single use, scoped to that repository, from the connections capability), never the
  account's code-host token sent to the machine. Progress: 2026-10-23 (lane C5), built; one criterion unproven live.
  In Repository, "Clone onto" picks this computer (Cloud on a hosted plane) or a machine place, and "Clone into a
  folder on <machine>" defaults to the parent of the machine's first shared folder and opens its own folder dialog
  to change it. `machines.clone` (`POST /api/claxedo/host/machines/:enrollmentId/clone`) asks `repositoryConnection`
  whether one of the caller's connections reads the repository. If one does, the egress broker mints a machine
  repository binding for that clone alone: only `info/refs` and `git-upload-pack` of that repository, the
  connection's token read per request, the enrollment checked at its serving generation, and the stand-in recorded
  in the pass register and spent when the machine answers. The machine's git fetches through it for that one
  process, with `origin` staying the repository's URL. The machine clones with `cloneInto`
  (`claxedo-server-core/src/hosts/machine/clone.ts`, the desktop project store's clone too) and answers
  through a long answer that outlasts the relay's 30 s first-byte wait. Then `machines.assign` files the folder with
  its repository URL. Live: `02-projects-machine` clones the signed stack's git server onto a paired `claxedo connect`
  machine, beside its shared folder and then into a folder picked in its dialog, on web and phone; red with the
  machine's clone route unmounted ("build-box did not answer: HTTP 404"). Unproven live: a private GitHub repository
  through the broker. The signed stack's scripted GitHub serves no git smart-HTTP, and a machine's git (GnuTLS)
  would have to trust the stack's per-run certificate. Focused tests cover it: the composed broker against a
  stub GitHub (`hosted-egress-broker.test.ts`: fetch, refusal of push, other repositories, a superseded or paused
  machine, a gone connection, and the spent stand-in), and a real git clone through a loopback broker on the
  machine (`host-management.test.ts`).
- [x] **New worktree on <machine>.** The Where chip offers "New worktree on <name>" for a connected machine's folder,
  with the base-branch choice it has locally, created on first send as local worktrees are. Progress: done
  2026-10-23 (lane C5). The Where chip offers it once per connected machine holding a checkout of the project (the
  account catalog does not tell its folder from its worktrees). The base branch comes from that checkout's refs
  through the relay. On the first send the app runs `machines.worktree`, and the machine makes it with the code
  the desktop's worktree route runs, now in `claxedo-server-core/src/hosts/machine/worktree.ts`. Then
  `machines.assign` files it into the folder's project on its branch, under the project's own repository key. Live:
  `02-projects-machine` picks "New worktree on build-box" with base `release`, sends, and reads back the worktree's
  commit on the machine, its catalog row in the folder's project on its branch, the machine's served set and the
  draft's route `/w/<worktree>/session`, on web and phone; red with the machine's worktree route unmounted (502). The
  first turn itself is not run there: the machine runtime has no scripted ACP connection ("Connection scripted-acp
  is not configured on this runtime"), which is the harness on a connected machine, not this item.
- [x] **Where it runs.** Settings → Projects → Where it runs offers Open, and "Clone at this location" for a
  connected machine's folder that is gone, as it does for this computer's. Progress: done 2026-10-23 (lane C5).
  Each connected machine's row has Open. While its machine is online the row also asks the machine whether the
  folder is still there (`queries.folders.presence`, one level through `machines.folders`, fresh for 30 s). A gone
  folder reads "Folder missing: <path>" with "Clone at this location", which clones the workspace's recorded
  remote back into it through `machines.clone`. Live: `02-projects-machine` deletes a clone on a paired machine,
  finds it missing in Settings → Projects, clones it back, and reads the checkout and its origin on the machine, on
  web and phone; red with the presence read switched off (no "Folder missing"). A machine reaches host management
  only through a folder it serves, so a machine whose one folder is gone cannot be asked.
- [ ] **Again in another folder.** Running the connect command in another folder on a machine that is already
  connected asks the owner in the app to add that folder; it never re-enrolls the machine. Progress:
- [x] **One path.** Hosted operations for these (`machines.folders`, `machines.assign`, `machines.unassign`,
  `machines.clone`, and the worktree create) reuse the route `claxedo host assign` uses and the local server's clone
  and worktree code moved behind the grant, so each operation has one implementation for every machine. Progress:
  done 2026-10-23 (lane C5). `machines.assign` and `machines.unassign` are the host-assignment routes `claxedo host
  assign` and `claxedo host unassign` use. Where it runs' "Remove" on a connected machine's row is
  `machines.unassign`: the folder stays on the machine. `machines.folders`, `machines.clone` and
  `machines.worktree` reach the machine under a host-management grant. Each runs the code the desktop runs for its
  own folders: `claxedo-server-core/src/hosts/machine/folders.ts` (listing and bounded search),
  `hosts/machine/clone.ts` (`cloneInto`, which the local project store now calls) and `hosts/machine/worktree.ts`
  (naming, base, `git worktree add`, which the local worktree route now calls). The local copies are gone. Not yet:
  a desktop that serves its folders to other devices through remote access does not mount host management, so
  another device cannot run these operations on it.
- [ ] **Parity proof.** e2e flow 2 (add a folder, clone, edit, remove, deep link, worktree branches) passes against a
  connected machine as it does against this computer, on the web and the desktop. Progress: 2026-10-23 (lane C5),
  partly. Covered on web and phone (`02-projects-machine`, 5 flows, 10 runs green, each with a recorded red run):
  - add a folder;
  - clone, beside the shared folder or into a picked one;
  - deep link to the project's settings;
  - remove from the machine;
  - Clone at this location for a gone folder;
  - a new worktree from a chosen base;
  - a gone base kept for a corrected retry.

  Open, each for its own reason:
  - edit: the hosted plane serves no project configuration for any project, its own or a machine's;
  - the worktree cases that run a turn on the machine (a refused session kept for retry, dirty-source and tag
    cases with sessions): the machine runtime has no scripted ACP connection, "Connection scripted-acp is not
    configured on this runtime";
  - the desktop app as the client: `packages/claxedo-desktop` is lane C9's, and the desktop's own folders are not
    reachable through host management.
- [x] The terminal never lists folders; in the app, folders appear only through the folder dialog's search and one
  level at a time, as on this computer. Progress: done 2026-10-23 (lane C5). A machine answers folder reads only as
  its home, one folder's subfolders, or a search under one folder (at most 200 results, three levels deep, 400
  folders visited), each on its own one-minute grant. The app reads them only from the folder dialog. The CLI
  prints the folder it shares while pairing and, in `claxedo status`, the folders it serves; it lists no other
  folder.

### C6 — Failures, explained where the person looks

- [ ] The machine reports its blocking reason to the control plane when it can reach it: no linger on Linux, a live
  desktop daemon beside it, a CLI below the accepted version, a service the OS stopped. The machine's Details shows
  the one line and the command that fixes it. Progress: `POST /api/claxedo/host/enrollments/report` (machine-signed,
  admitted while held) records the CLI version and system in `machine_json` and one reason in `blocked_json`
  (`MACHINE_BLOCKED_REASONS`: `linger_off`, `user_manager_unreachable`, `waiting_for_logon`, `desktop_daemon`,
  `stopped`) with the fix command the machine names; acquiring a serving generation clears it, an instance a newer
  one superseded is not heard, and a heard block ends the lease. `claxedo connect` reports after it acquires, when
  its service did not start, beside a live desktop daemon once enrolled, and on SIGTERM/SIGINT after the drain. A
  service killed without a signal (SIGKILL, power loss) cannot report; it reads Offline with no cause. A CLI below
  the accepted version is the control plane's update hint (C7), not a machine report. Proven by D1, route, CLI and
  e2e flow 15 (the stop); no linger also live on Linux through the real `connect --pair --install-service` (not a
  committed flow: it would install a real service on macOS or Windows); the user manager, logon and desktop-daemon
  refusals by CLI tests only (Windows and macOS not run).
- [x] Offline reads "Offline · last seen <time>", with the most likely cause when the machine reported one before
  going away. Progress: the list row and Details read "Offline · last seen … · Claxedo was stopped there" (e2e flow
  15, web and phone).
- [x] Pasting the command on a machine that is enrolled, removed or reset offers to connect it again (it asks once
  when it can ask, and says what it replaces), so nobody needs `--reset`. Progress: `pair()` in
  `packages/cli/src/connect/pair.ts`. A machine connected to the code's person asks to share the folder the command
  runs in and never enrolls again; one its owner removed, or one connected to another control plane, says so, asks
  "Connect this machine again?" once and replaces its state only on yes (its service stays and serves the new
  connection); a reset machine has no state and pairs as new. Proven by the CLI's pair tests, the connector's pairing
  tests and the D1 test "a connected machine's code asks to share another folder"; the other-control-plane branch
  has no test of its own.
- [ ] Every line the connect flow prints, in the app and on the machine, is one short line (root AGENTS.md).
  Progress:

### C7 — Managing a machine from the app

- [x] Details renames the machine, changes its roots (assignments outside them are retired, after a confirmation
  naming them) and removes it, with each delete confirming in a dialog. Progress: `machines.rename` and
  `machines.setRoots`; the devices list names, per root, the assignments removing it alone retires, and Stop sharing
  confirms naming them (e2e flow 15, web and phone).
- [x] Details shows the CLI version and, below the version the control plane accepts, "Update available" with the
  command; W11 owns automatic updates. Progress: the devices list carries `update` (the connect script with no code,
  then `claxedo connect --install-service`, which now restarts a running service) while `cli_version` is below
  `MINIMUM_CONNECT_CLI_VERSION`. The D1 test "the plane offers the update command … while its CLI is below the
  accepted version, and nothing once it is not" proves both sides; e2e flow 15 asserts the hint follows
  `cliVersionBelowAccepted` for the repository's CLI, which at 0.2.2 is the accepted version, so it shows none.

### C8 — Servers without a browser

- [x] The drawer's "For a server without a browser" mints a pre-approved invitation with a name and the folder to
  share, typed as the server writes it, because a cloud-init run has no meaningful working folder. It is shown as a
  cloud-init snippet and as one command. Today's `--token-file` path stays for it. Progress: `ServerConnect`
  (`claxedo-app/src/settings/view/server-connect.tsx`) mints through `machines.invite`, the owner's
  `POST /api/claxedo/host/invitations` with `sharesRoot`; the control plane answers the cloud-init snippet and the
  macOS / Linux and Windows commands from its own origin (`invitationCommands`). On redemption it assigns the folder
  as the machine's first workspace as the person who minted it (`first_workspace_id`), so the machine serves it with
  no approval, and the invitation's name names the machine. `install.sh --invitation T --root DIR` and
  `install.ps1 -Invitation T -Root DIR` write the token to a file only the user reads and run
  `claxedo connect --token-file F --root DIR --install-service`. Flow 15 runs the real `claxedo connect --token-file
  --root` from the drawer's command on the web and the phone. Not yet run: the snippet on a real cloud VM's first
  boot, and `install.ps1` on Windows.
- [ ] On Linux the script enables linger where it may and otherwise prints the one command that does. Progress:
  `install.sh` turns lingering on with `loginctl --no-ask-password enable-linger` (root, as cloud-init runs, always
  may), says so in one line or prints `sudo loginctl enable-linger <user>` in one line, and when `XDG_RUNTIME_DIR`
  is unset waits up to 10 s for the user manager's bus and exports it. Covered by `install-sh.test.ts` against a
  fake `loginctl`; not yet run on a real systemd host.

### C9 — Add a machine over SSH from the desktop app

- [ ] The desktop app connects a machine it can reach over SSH: install, pair and approve in one flow, with a
  checksum-verified release. Moved from W5. Progress: built. The drawer's Connect over SSH… (desktop only) takes
  `[user@]host`, an optional port, key file and folder; Electron main (`claxedo-desktop/src/main/ssh-connect/`) runs
  the system `ssh` in BatchMode, shows an unknown host's fingerprints until the person trusts them into their own
  known_hosts, fetches `/api/claxedo/connect` from the account's plane and runs it only when it matches the
  `x-claxedo-script-sha256` the plane states, then streams those bytes to `sh -s -- <code>`; the numbered steps and
  the same approval card follow. Proven live on Linux through the real desktop UI against the signed stack and a
  local sshd (trust a fingerprint, refused sign-in, missing folder, install, approve, ready); macOS and Windows
  clients are unverified. No committed e2e flow covers it yet: the harness has no sshd of its own, and its
  Electron launch forces the basic password store, which a signed desktop on Linux refuses.

## 4. Order

1. **First:** C0.
2. **Then, in parallel:** C1 with C3 (they share the pairing contract), C2, C4.
3. **Then:** C5, C6.
4. **Later:** C7, C8, C9.

## 5. Definition of done

- [ ] On fresh Ubuntu 24.04, macOS and Windows machines against staging, a person signed in to the web app goes from
  **Connect a machine…** to a first session's first output in a folder on that machine with one command pasted on
  the machine and every other step in the app: no token file, no second computer, no `--root`, no `claxedo host
  assign`.
- [ ] That journey takes ≤ 2 min on Linux and macOS and ≤ 5 min on Windows, install included, measured the way C0
  measured today's.
- [ ] The same journey works from the desktop app.
- [ ] On a connected machine, a person creates a project from a folder, from a cloned repository and as a new
  worktree, from the web and the desktop, the same way they do on this computer (e2e flow 2 against a connected
  machine).
- [ ] Each failure in C1, C3 and C6 shows its one-line cause in the app and on the machine, and its recovery is
  exercised live.
- [ ] e2e flow 15 (`15-settings-connect-machine`, beside `15-settings-machines`) covers pairing, approval, denial and expiry on the web and the desktop. The nightly real-machine run in the machine-connection plan's definition of done runs this journey.
- [ ] The behaviour is documented where it lives (`claxedo-app/src/settings/README.md`, `packages/cli/README.md`),
  and this plan is deleted once the work ships.

## 6. Execution

Run the workstreams as parallel lanes with disjoint file ownership, each proving its slice live before merge:

- **Pairing lane (C1 server, C3):** the invitation and enrollment store and routes in `claxedo-server`, the hosted
  operations in `account-contract`.
- **Script and CLI lane (C1 scripts, C2, C8):** `packages/cli` (`connect --pair`, `install.sh`, the new
  `connect` and `connect.ps1`), and the control-plane route that serves them.
- **App lane (C1 drawer, C3 card, C4, C7):** `claxedo-app/src/settings` and `claxedo-app/src/server`.
- **Machine projects lane (C5):** the host-management grant (minted in `claxedo-server`, verified in
  `claxedo-host-serving`), the machine's folder, clone and worktree operations behind it, and the app's create-project
  form, folder dialog and Where chip for a connected machine (`claxedo-app/src/projects`). The grant lands first;
  the folder dialog, clone and worktree slices then run in parallel.

Use a workflow for C0 and for the definition of done's three-OS journey: one agent per OS box, run in parallel,
each returning timings and a recording. The pairing contract (the operation names, the enrollment's
awaiting-approval state, what the machine reports) is agreed first and frozen before the lanes split, since three
lanes build on it.
