# Onboarding v2: project → AI → where it runs

Status: proposed; not started. Supersedes and deletes
`2026-09-14-002-feat-onboarding-v1-repair.md`: v1 is not repaired, it is
removed, with no flag and no compatibility path for its dismissal keys.

Assessed live on 2026-09-15 against `claxedo-server` on a wiped
`CLAXEDO_DATA_DIR` and `claxedo-app dev:local`, with and without
`VITE_CLAXEDO_ONBOARDING_V1`.

## What a new user meets today

Flag off (the shipped product): the no-project canvas
`app/workbench/rail/first-project-canvas.tsx` renders
`features/workspaces/ui/project-create-form.tsx` as the screen — **Name**,
then **Folder** (or "Clone a repository instead" → a URL field), then
"Create project". That is the whole first run. Nothing asks whether an AI
login exists, and nothing asks where work runs; both are discovered at the
first send, or never.

Flag on: `OnboardingEmptyState` puts "Set up Claxedo, Step 1 of 2 — Do you
want to run cloud sessions too?" in front of that canvas. The six defects are
recorded in the superseded plan; the one that matters here is that its first
question is the cloud question, which the feature's own `AGENTS.md` records
as the design that failed its stress test.

Observed facts the design below rests on:

- `ProjectCreateForm` already derives a name (`suggestedName` = basename of
  the folder or repository URL, `effectiveName` falls back to it), but the
  field sits first and looks required.
- Repository projects on the local server are cloned synchronously by
  `LocalProjectRoutes` (`claxedo-local-server/src/workspace/routes/projects-route.ts`)
  into `<dataDir>/projects/<slug>`; a private GitHub clone takes the caller's
  connected GitHub token through `cloneCredential` in
  `claxedo-server/src/deployments/self-hosted-node/app.ts`.
- GitHub connection exists end to end in `@claxedo/connections`: device flow
  when the server has a client id, pasted token otherwise
  (`impls/github.ts`), mounted at `/api/claxedo/integrations` and read by
  `features/onboarding/code-host-api.ts` (`connectCodeHost`).
- Listing the connected account's repositories exists server-side
  (`GET /connections/:id/repositories` → `service.listRepositories` →
  `api.github.com/user/repos`) and as the hosted operation
  `connections.repositories` in `platform/account/account-port.ts`. **No app
  surface calls it.**
- The hosted plane has no `/api/claxedo/projects` (route family
  `local-projects`, owner `local-server`; no hosted mount). On hosted, a
  project comes into being with its first cloud workspace:
  `HostedWorkspaceRoutes` `createCloudBody` takes `projectName`, and either
  `repoUrl` or `connectionId + repo.fullName`, resolving the clone token via
  `connections.repositoryForAuth`. The app already sends that shape from
  `features/workspaces/data/workspace-create-api.ts`. So on the web, the
  "Create project" the canvas shows today posts to a route that does not
  exist there (inference from route ownership; not exercised live).
- Sandbox providers: catalog + key + verify-by-probe exist
  (`features/onboarding/sandbox-provider-api.ts`, drivers `daytona`,
  `modal`, `vercel`, `docker` in `sandbox-manager/src/driver-catalog.ts`),
  and Settings → Sandbox renders the same. Hosted is bring-your-own-key
  (decision 2026-09-15).
- AI logins: Settings → Providers is the authority.
  `features/settings/provider-detect.ts::runProviderDetect()` reads this
  machine's harness logins, the stored credential rows and the server's
  effective selection in one call; `ui/controls/account-status.ts::accountReach`
  turns the authority's `deliverable` field into `local-only` /
  `local-and-cloud`; `POST /credentials/:id/verify` probes a row without
  spending (usage reads for ChatGPT and Claude OAuth).
- Connecting another machine: invitations are minted by
  `POST /api/claxedo/host/invitations` (`routes/hosted/host-enrollment.ts`)
  and redeemed by `claxedo connect --token-file` (`packages/cli`). Only the
  CLI (`claxedo host invite`) mints one; the app's account-port has
  `host.enrollCurrentMachine` and heartbeat operations but **no
  `host.invitations.create`**. Host folder operations and machine worktrees
  are deferred in the connect plan (P4–P7), so a freshly connected machine
  cannot yet be told to clone a repository.
- `RemoteAccessSurface` and `useRemoteAccessController` live in
  `features/onboarding` but their only production caller is
  `app/dialogs/settings.tsx` (Settings → Remote access);
  `remote-access-marker.tsx` is mounted by `app/entry/app.tsx`. They are a
  Settings feature filed in the wrong directory, not onboarding.

## Goal

A first run that ends in a working session with the fewest questions that
still have to be asked, asked in the order they become answerable, each
answered by observing where observation is possible:

1. **Project.** Where the code is.
2. **AI.** What runs it, verified.
3. **Where it runs.** This machine, a cloud sandbox, or another machine —
   optional where this machine can run work, required where it cannot.

The wizard is the no-project screen and nothing else: it never overlays a
live rail, it never returns once a project exists, and every later change
happens in Settings, which already has a page per step.

## Design

### Where it lives and when it shows

`FirstProjectCanvas` becomes the host of a three-step surface. The only
visibility rule is the one the canvas already has: **no project on the
server**. There is no dismissal, no checklist card, no flag. Steps 2 and 3
are reachable afterwards through Settings → Providers / Sandbox / Remote
access, which exist today.

Two products, one component, one discriminator the app already computes:
`localExecution` from the server health document (`serverHealthQueryOptions`),
which is `true` for the self-host binary and the desktop's embedded server and
`false` for the hosted plane. Everything below that says "desktop" means
`localExecution === true` and "web" means `false`.

### Step 1 — Project

**Desktop.** Folder first, no Name field. The form is a folder picker
(existing `pickProjectFolderWith(dialog)`) and a "Clone a repository instead"
switch. The name is derived on the server when the client sends none:
`projects-route.ts` makes `name` optional and derives it from
`git remote get-url origin` (`owner/repo` → `repo`, as
`ownerRepoFromRemote` already does client-side), falling back to the folder
basename; a clash appends `-2`, `-3`. The created name shows in the wizard's
step header with a Rename affordance that calls the existing
`PATCH /api/claxedo/projects/:id`. Derivation lives on the server because
that is the only side that can read the folder's git config.

**Clone (both products).** "Clone a repository" opens the same panel in
three states, driven by `readCodeHostStatus`:

- No GitHub connection → the connect block from today's
  `DestinationSurface` (device flow button when the integration declares
  `oauth`, token paste when it declares only `key`), inline. Success
  advances to the list.
- Connected → a searchable repository list from
  `GET /api/claxedo/integrations/connections/:id/repositories` (local) /
  `connections.repositories` (hosted), sorted by GitHub's `updated`, with
  the search filtering `fullName`. Selecting a row is the answer.
- "Paste a URL instead" stays as a text link for public or non-GitHub
  repositories — it is the only path that clones anonymously.

On desktop, selecting a repository posts
`{ source: { kind: "repository", connectionId, repo: { fullName } } }` to
`/api/claxedo/projects`; the route gains that variant beside `repoUrl` and
resolves the clone URL and token through the same
`connections.repositoryForAuth` the hosted create uses, so both products
authenticate a clone one way.

On web there is no project route: the selection is held as the wizard's
draft (`{ connectionId, repo }` or `{ repoUrl }`) and becomes the
`projectName` + source of the hosted workspace create in step 3.

### Step 2 — AI

The step reuses the Providers page's data path, not a parallel one:
`runProviderDetect()` and `accountReach` are handed to the wizard through
`features/onboarding/app-ports.ts` (the feature may not import
`@/features/settings/*`).

**Desktop.** On entering the step, detect runs once, unprompted. The screen
lists what it found — one row per harness login with the reach marks the
Providers page draws (`local-only`: "works on this machine",
`local-and-cloud`: "works here and in cloud sandboxes"). If at least one
login is `working`, the step reads as done and Next is enabled; the copy
says these logins run sessions on this machine only. An "Add a login that
cloud sandboxes can use" disclosure opens the same connect card the
Providers page uses (`ProviderConnectCard`), because a `local-only` login
will not carry into a step-3 sandbox. If nothing is found, the harness
picker below is the screen.

**Web.** No machine to scan. The screen is a harness picker (`pi`,
`opencode`, Claude Code, Codex — the catalog `harnessDisplayLabel` names),
and choosing one shows that harness's setup: the provider list scoped to it
(`useProviders(harness)`), the connect card for the chosen provider, and for
subscription logins the exact instruction (`claude setup-token`, ChatGPT
login paste) the Providers page already carries. Done means a stored row
that `POST /credentials/:id/verify` reports as `working`; the row's reach
must be `local-and-cloud`, and a `local-only` answer is shown as the reason
Next stays disabled, in the footer as text.

Verification is the Providers page's own probe, so "connected but cannot
run a turn" — the funnel's recorded largest leak — is caught at this step.

### Step 3 — Where it runs

**Desktop.** Optional. Default row "Just this machine" is selected and
Finish is enabled on entry. Two further rows: "A cloud sandbox" and "Another
machine". The step exists on desktop only so a user who wants the cloud from
day one is not sent to Settings to find it.

**Web.** Required. No "this machine" row; Finish stays disabled until one of
the other two is done, with the reason in the footer text.

- **A cloud sandbox.** Provider catalog + key + verify, as
  `sandbox-provider-api.ts` does today (`saveSandboxProviderKey`, then the
  server's `verification.state`). `working` is done; `unknown` (Modal) is
  accepted with its reason shown; `broken` is not.
- **Another machine.** The app mints an invitation through a new account
  operation `host.invitations.create` (the CLI's `inviteMachine` body:
  `displayName`, `scope.allowed_roots`, `expiresInMs`), shows the install
  one-liner (`packages/cli/install.sh`) and
  `claxedo connect --token-file <file> --root <root> --install-service`
  with the token, and polls `host.invitations.list` / the machine list until
  the enrollment appears. The machine showing up is done.

### Finish

**Desktop.** The project already exists from step 1: the wizard hands
`onProjectCreated` the same `{ id, worktree }` the canvas hands today, and
the composer opens on it with the environment step 3 chose preselected
(`local` or `cloud`; `user-hosted` when a machine was connected).

**Web, cloud sandbox.** One call: the hosted workspace create with the
step-1 draft as source, the derived `projectName`, and the step-3 provider
as `driver`. The response's workspace is opened. This is the only place the
web wizard creates anything, so an abandoned wizard leaves nothing behind.

**Web, another machine.** The connect plan's P4 (host folder operations and
machine worktrees) is the missing half: nothing today can ask the connected
machine to clone the step-1 repository. Until P4 lands, Finish on this
branch opens the workspace list, where the host's served roots appear as
projects when it serves any; the wizard says so in plain words. This is a
recorded gap, not a hidden one.

### Funnel

`funnel.ts` stays and its events keep their names: `setup_form_shown` when
the wizard mounts, `step_done` with `step: "project" | "ai" | "execution"`,
`first_turn_ok` from the session screen as today. The `destination` and
`remote-access` step ids disappear with their steps.

### What is deleted, moved, kept

Deleted, with tests (no importer survives outside the wizard):
`registry.ts`, `setup-shell-state.ts`, `setup-page.tsx` + `.css`,
`dismissals.ts`, `go-further.ts`, `home-view.ts`, `navigation.ts`,
`state.ts`, `destination.ts`, `destination-surface.tsx`,
`ai-connect-state.ts`, `ai-connect-surface.tsx`,
`app/workbench/rail/onboarding-empty-state.tsx`, the `ONBOARDING_V1`
constant and `onboardingOverlayDirectory` in `rail-workbench-canvas.tsx`,
the `VITE_CLAXEDO_ONBOARDING_V1` export in `script/onboarding-desktop.sh`,
and the `opencode.*` dismissal keys' readers.

Moved to `features/settings/remote-access/` (their only caller is
Settings): `remote-access-controller.ts`, `remote-access-marker.tsx`,
`remote-access-state.ts`, `remote-access-surface.tsx` and their tests;
`app/dialogs/settings.tsx` and `app/entry/app.tsx` follow the import.

Kept because the wizard calls them, each re-read against its new caller:
`code-host-api.ts` (connect + status), `sandbox-provider-api.ts`,
`sandbox-provider-query.ts`, `ai-connect-api.ts` (still exported through
`features/settings/app-ports.ts`), `funnel.ts`, `error-text.ts`,
`app-ports.ts`. `credential-query.ts`, `credential-resolution.ts`,
`credential-sharing.ts` are kept only if step 2 uses them after the
Providers-page data path is wired; otherwise they go in the same commit.

`ProjectCreateForm` keeps its three hosts (composer Project chip, dialog,
wizard). It loses the Name field in every host — the composer's chip
benefits the same way — and gains the repository-list state; the chip host
passes the same ports the wizard does.

## Change points

- `packages/claxedo-local-server/src/workspace/routes/projects-route.ts` —
  `name` optional with server-side derivation and clash suffix; `source`
  accepts `{ kind: "repository", connectionId, repo: { fullName } }`.
- `packages/claxedo-server/src/deployments/self-hosted-node/app.ts` —
  `LocalProjectRoutes` receives a `repositoryForAuth`-shaped resolver in
  place of `cloneCredential`, the same one `HostedWorkspaceRoutes` takes.
- `packages/claxedo-app/src/platform/account/account-port.ts` +
  `hosted-operations.ts` — `host.invitations.create`, `host.invitations.list`.
- `packages/claxedo-app/src/features/workspaces/data/project-api.ts` —
  `ProjectSource` gains the connection variant; `createProject` sends no
  name when the caller has none.
- `packages/claxedo-app/src/features/workspaces/ui/project-create-form.tsx`
  — folder-first, no Name field, repository list state, URL as a link.
- `packages/claxedo-app/src/features/onboarding/` — replaced by
  `wizard.tsx` (host, step order, footer reason), `project-step.tsx`,
  `ai-step.tsx`, `execution-step.tsx`, `draft.ts` (the web draft), and
  their tests; `app-ports.ts` gains `runProviderDetect`, `accountReach`,
  `ProviderConnectCard`, `useProviders`, `verifyCredential`.
- `packages/claxedo-app/src/app/workbench/rail/first-project-canvas.tsx` —
  hosts the wizard; the headline and lede become the step-1 copy.
- `packages/claxedo-app/src/app/workbench/rail/rail-workbench-canvas.tsx` —
  no onboarding branch; the no-project screen is the canvas.
- `packages/claxedo-app/src/features/onboarding/AGENTS.md` — rewritten from
  the new code: owns the first-run wizard; the rationale section keeps the
  funnel-leak and pull-not-push lessons and drops the remote-access one
  (that surface no longer lives here).
- `docs/plans/README.md` — this entry replaces the v1 repair entry.

## Definition of done

- [ ] On a wiped `CLAXEDO_DATA_DIR` with `dev:local`, the first screen is
      the wizard's project step with a folder picker and no Name field;
      picking a folder with a git remote creates a project named after the
      remote's repository, and a folder without one after its basename.
      Progress:
- [ ] "Clone a repository" with no GitHub connection shows the connect block
      inline; connecting advances to a searchable list of that account's
      repositories; selecting one creates the project on the local server
      through `connectionId + repo`, and the clone authenticates with the
      connection's token (asserted by the route test, not by a 200).
      Progress:
- [ ] "Paste a URL instead" clones a public repository anonymously, as today.
      Progress:
- [ ] Step 2 on desktop runs detection without a click, lists each login with
      its reach marks, and enables Next when one is `working`; with none it
      shows the harness picker.
      Progress:
- [ ] Step 2 on a hosted stack: choosing a harness shows its providers; a
      pasted key that the server verifies as `working` and `local-and-cloud`
      enables Next; a `local-only` or `broken` answer shows its reason as
      footer text and Next stays disabled.
      Progress:
- [ ] Step 3 on desktop is preselected "Just this machine" and Finish opens
      the composer on the new project; choosing a sandbox provider and saving
      a working key preselects the cloud environment.
      Progress:
- [ ] Step 3 on hosted: Finish is disabled until a provider key verifies or a
      machine enrolls; the invitation the wizard mints is redeemable by
      `claxedo connect --token-file` (Tier R fixture host), and the wizard
      shows the machine within one poll of enrollment.
      Progress:
- [ ] Web finish with a cloud sandbox creates exactly one hosted workspace
      whose project name is the derived repository name and opens it; an
      abandoned wizard creates nothing (asserted against the authority).
      Progress:
- [ ] Web finish with a connected machine opens the workspace list and states
      the P4 gap in the wizard copy; no call is made that cannot succeed.
      Progress:
- [ ] Settings → Remote access renders and behaves as before from
      `features/settings/remote-access/`; `app/entry/app.tsx` mounts the
      marker from there. `git grep -n "features/onboarding/remote-access"`
      returns nothing.
      Progress:
- [ ] `git grep -n "ONBOARDING_V1\|onboardingOverlayDirectory\|OnboardingEmptyState\|setupShellMode"`
      returns nothing; every deleted module's test is deleted with it; no
      kept module in `features/onboarding` lacks a production importer.
      Progress:
- [ ] The composer's Project chip creates a project with no Name field and
      the repository list, through the same `ProjectCreateForm`.
      Progress:
- [ ] Funnel: `setup_form_shown`, `step_done` ×3 with the new step ids, and
      `first_turn_ok` fire in order in a rendered test.
      Progress:
- [ ] Gates: `bun run test:architecture-ratchets`; app vitest + bun test;
      local-server and claxedo-server vitest for the projects route and the
      invitation operations; `turbo typecheck`; Playwright proof of the
      desktop path (steps 1–3, folder + clone) against a real local stack in
      both themes, and of the hosted path against the signed-web e2e stack.
      Progress:
- [ ] `docs/plans/2026-09-14-002-feat-onboarding-v1-repair.md` is deleted and
      the README entry points here.
      Progress:

## Execution: parallel lanes with disjoint ownership

Fable subagents only (user ruling 2026-09-14). Six lanes, one owner each,
`git commit -- <paths>` per lane on the shared worktree; the orchestrator
reads every diff and re-runs the lane's gate before accepting, then runs the
Playwright proofs itself.

- Lane S1, local projects route: `projects-route.ts` (optional name,
  derivation, clash suffix, connection source), `self-hosted-node/app.ts`
  wiring, their tests. Gate: local-server + claxedo-server vitest.
- Lane S2, invitation operations: `account-port.ts`, `hosted-operations.ts`,
  the hosted operation inventory test, a client for
  `host.invitations.create/list`. Gate: app vitest, hosted-operation
  inventory guard.
- Lane A1, form: `project-api.ts`, `project-create-form.tsx`, the repository
  list, the composer chip host in `session-new-design-view.tsx`. Depends on
  S1's contract (agree the body shape first; S1 lands first). Gate: app
  vitest.
- Lane A2, wizard: `features/onboarding/{wizard,project-step,ai-step,
  execution-step,draft}.tsx`, `app-ports.ts` additions, `first-project-canvas.tsx`,
  `rail-workbench-canvas.tsx`, funnel wiring. Depends on A1's form and S2's
  client. Gate: app vitest + bun test.
- Lane M, remote-access move: the four files + tests to
  `features/settings/remote-access/`, `settings.tsx`, `app.tsx`,
  `features/settings/AGENTS.md`. Independent. Gate: app typecheck, the
  settings vitest files.
- Lane D, deletion: everything in "Deleted" above plus `index.ts`,
  `AGENTS.md`, `script/onboarding-desktop.sh`, the superseded plan and the
  README entry. Lands after A2 and M so no importer breaks mid-stream. Gate:
  ratchets, `git grep` checks from the DoD.

S1, S2 and M start together; A1 after S1; A2 after A1 and S2; D last.
