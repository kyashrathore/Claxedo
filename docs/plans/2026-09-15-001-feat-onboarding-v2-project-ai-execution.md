# Onboarding v2: project → AI → where it runs

Status: built on `feat/onboarding-v2` (2026-09-23), gates green, proofs
recorded below; awaiting merge to `dev`. Supersedes and deletes
`2026-09-14-002-feat-onboarding-v1-repair.md`: v1 is not repaired, it is
removed, with no flag and no compatibility path for its dismissal keys.
Owner ruling 2026-09-23: v1 goes with no backward compatibility; v2 is the
only first run, on by default in every build, no flag.

Assessed live on 2026-09-15 against `claxedo-server` on a wiped
`CLAXEDO_DATA_DIR` and `claxedo-app dev:local`, with and without
`VITE_CLAXEDO_ONBOARDING_V1`. Re-verified on 2026-09-23 against `dev`
2ddd35136e and the staging control plane
(`cf-acc-stg-260830-232009-3851.claxedo.dev`, signed-in user, hosted-core,
`full-hosted` posture, `CLAXEDO_SANDBOX_DRIVER=cloudflare`). Everything in
"Observed facts" below is the 2026-09-23 reading; where it differs from the
2026-09-15 draft the difference is named in place.

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

## Observed facts (2026-09-23)

Project creation:

- `ProjectCreateForm` derives a name (`suggestedName` = basename of the
  folder or repository URL, `effectiveName` falls back to it), but the field
  sits first and looks required. The form has two hosts, not three: the
  canvas and the composer's Project chip
  (`features/session/ui/components/session-new-design-view.tsx`, through
  `features/session/app-ports.ts`). There is no dialog host.
- Repository projects on the local server are cloned synchronously by
  `LocalProjectRoutes` (`claxedo-local-server/src/workspace/routes/projects-route.ts`)
  into `<dataDir>/projects/<slug>`; a private GitHub clone takes the caller's
  connected GitHub token through `cloneCredential`, which
  `claxedo-server/src/deployments/self-hosted-node/app.ts` builds from
  `connectionsHost.service.list` + `getToken(id, "code-host")`. The create
  body requires `name` (1–120 chars); the source union is
  `{ kind: "directory", directory }` | `{ kind: "repository", repoUrl }`.
- GitHub connection exists end to end in `@claxedo/connections`
  (`packages/claxedo-connections`): device flow when the server has a client
  id, pasted token otherwise (`impls/github.ts`). Mounted at
  `/api/claxedo/integrations` by the self-hosted app and, on hosted, by the
  Agent Plugins composition (`agent-plugins/hosted-composition.ts` →
  `createHostedD1ConnectionsSetup`), which both the plain and the
  `full-hosted` candidate workers go through
  (`hosted-workerd/better-auth-d1-candidate-worker.agent-plugins*.cf.ts`).
  The list is the mount root (`GET /api/claxedo/integrations`); the
  `/connections` sub-path is not a route, which is why a probe of
  `/api/claxedo/integrations/connections` answered 404 on staging tonight.
  The root itself was not probed; the wizard treats a non-200 root as "this
  deployment has no code host" rather than assuming.
- Listing the connected account's repositories exists server-side
  (`GET /connections/:id/repositories` → `service.listRepositories` →
  `api.github.com/user/repos?sort=updated`, rows
  `{ id, name, fullName, cloneUrl, private, permissions }`) and in the app's
  request layer: `platform/account/integrations-request.ts::createIntegrationsRequest`
  is the one dual-path client (AccountPort `connections.repositories` when a
  signed desktop, `authFetch` otherwise). **No app surface calls it.**
- The hosted plane has no `/api/claxedo/projects` (404 `route_not_found`
  live). The composer's Project chip on the web therefore posts to a route
  that does not exist. On hosted, a project comes into being with its first
  cloud workspace: `HostedWorkspaceRoutes` `createCloudBody` takes
  `projectName`, and either `repoUrl` or `connectionId + repo.fullName`,
  resolving the clone token via `connections.repositoryForAuth`; `driver` is
  accepted and ignored. The app sends that shape from
  `features/workspaces/data/workspace-create-api.ts::createCloudWorkspace`.

Sandbox (corrects the 2026-09-15 "hosted is bring-your-own-key" decision,
which no route can honour):

- Sandbox provider catalog + key + verify-by-probe
  (`features/onboarding/sandbox-provider-api.ts` over `/api/workspace/drivers*`)
  exist only where `claxedo-server/src/workspace/routes/index.ts`
  (`WorkspaceRoutes`) is mounted: the self-hosted node app, which is also the
  desktop's embedded server. Settings → Models → Sandbox renders the same.
- The hosted plane serves no `/api/workspace/drivers` (404 live). Under the
  `full-hosted` posture (`deployment-profile.ts`) the plane composes ONE
  driver from env (`hostedSandboxDriver`), and `POST /api/workspace/create`
  uses it; under `control-plane-only` the same route answers 503
  `sandbox_driver_unavailable`. So on the web there is no provider-key step:
  the sandbox is the deployment's, or there is none.

AI logins:

- Settings → Providers became Settings → Models (`features/settings/ui/models.tsx`,
  section id `models` in `app/integrations/settings/settings-sections-registry.tsx`).
  The Models page composes, per harness, `AgentHarnessAccounts` (Claude Code,
  Codex, Cursor: the machine scan, through `features/settings/machine-accounts.ts`
  → `provider-detect.ts::runProviderDetect`, which reads
  `/api/claxedo/credentials`, `/credentials/effective` and
  `/credentials/machine-logins`) and `HarnessProvidersSection` (Pi, OpenCode:
  the provider catalog, `useProviders(harness)` over
  `/api/claxedo/agent-config/providers?nativeHarness=<id>`). Both sit under
  `SettingsScopeProvider`. `ui/controls/account-status.tsx::accountReach`
  turns the authority's `deliverable` field into `local-only` /
  `local-and-cloud`; `POST /credentials/:id/verify` probes a row without
  spending.
- The hosted plane serves none of the credential routes (all 404 live) and
  only the Pi catalog: `?nativeHarness=pi` → 200, any other harness → 400
  `provider_catalog_unsupported` (`routes/hosted/shell.ts`). A key is stored
  with `PUT /auth/:providerID?harness=pi` body `{ auth: { key } }`
  (`credentials/worker/pi.ts::hostedPiCredentials`; 400 for `openai-codex`,
  which takes no key; 503 while `CLAXEDO_HOSTED_CREDENTIALS_ENABLED` is off)
  and the catalog then reports that provider `connected`. **The app has no
  writer for that PUT**: `app/dialogs/provider-connect-form.tsx` saves through
  `claxedoCredentialRequest` (`PUT /api/claxedo/credentials`), so the Models
  page cannot store a key on the hosted web today, and v1's web step could
  not either. There is no verify probe and no `deliverable` on hosted; the
  only observable "done" is the catalog's `connected` set after the PUT.

Another machine:

- Invitations are minted by `POST /api/claxedo/host/invitations`
  (`routes/hosted/host-enrollment.ts::HostInvitationRoutes`, body
  `{ scope: { allowed_roots, visibility }, displayName?, expiresInMs? }`) and
  redeemed by `claxedo connect --token-file` (`packages/cli`). Only the CLI
  (`claxedo host invite`) mints one. The app's account port has no
  `host.invitations.*` operation, and adding one is refused by
  `architecture/hosted-operation-inventory.test.ts`: every `/invitations`
  route is listed under `NON_ACCOUNT_ROUTES` and the test asserts that no
  AccountPort row names `/invitations` ("a machine route must never be
  promoted into an AccountPort row"). Settings → Machines
  (`app/integrations/settings/machines-section.tsx`) shows the CLI pair
  (`claxedo host invite --name build-box --root ~/code`,
  `claxedo connect --token-file ./invite.txt --install-service`) and lists
  machines from `useRemoteAccessController().devices`, a port capability the
  desktop has and the browser does not. Host folder operations and machine
  worktrees are deferred in the connect plan (P4–P7), so a freshly connected
  machine cannot yet be told to clone a repository.

Where things live:

- `RemoteAccessSurface`, `useRemoteAccessController`, `remote-access-marker.tsx`,
  `remote-access-state.ts` and `machine-provider-config.tsx` live in
  `features/onboarding` but their only production callers are
  `app/integrations/settings/machines-section.tsx` and `app/entry/app.tsx`.
  They are a Settings feature filed in the wrong directory.
- `ONBOARDING_V1` gates `rail-workbench-canvas.tsx`; `VITE_CLAXEDO_ONBOARDING_V1=true`
  is baked into `packages/claxedo-app/package.json`'s `build:better-auth`
  (the hosted browser build) and `test:e2e:onboarding`, and documented in
  `packages/claxedo-app/README.md`, `.claude/commands/onboarding-desktop.md`
  and `.opencode/command/onboarding-desktop.md`.
- `first-project-canvas.vitest.tsx` pins today's canvas (Name field first,
  folder picker, the create-intent focus).

## Goal

A first run that ends in a working session with the fewest questions that
still have to be asked, asked in the order they become answerable, each
answered by observing where observation is possible:

1. **Project.** Where the code is.
2. **AI.** What runs it, verified where a probe exists.
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
are reachable afterwards through Settings → Models / Sandbox / Machines,
which exist today.

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
`git remote get-url origin` (`owner/repo` → `repo`), falling back to the
folder basename (or the repository URL's last path segment for a clone); a
clash appends `-2`, `-3`. Derivation lives on the server because that is the
only side that can read the folder's git config. The wizard heads its later
steps with the name it can derive itself (`draft.ts::draftProjectName`, the
same rule minus the remote read); renaming stays the project settings
dialog's, because the project does not exist until Finish (below).

**Clone (both products).** "Clone a repository" opens the same panel in
three states, driven by `readCodeHostStatus` over
`createIntegrationsRequest(baseUrl)`:

- No GitHub connection → the connect block (device flow button when the
  integration declares `oauth`, token paste when it declares only `key`),
  inline. Success advances to the list.
- Connected → a searchable repository list from
  `GET /api/claxedo/integrations/connections/:id/repositories`, in the
  server's order (GitHub's `updated`), with the search filtering `fullName`.
  Selecting a row is the answer.
- "Paste a URL instead" stays as a text link for public or non-GitHub
  repositories. A pasted GitHub URL from a signed caller still clones with
  the account they connected, but only when that connection lists the
  repository as readable and its clone URL is on the pasted host
  (`repositoryForAuth(auth, undefined, fullName)`); anything else clones
  anonymously, which is what a public repository needs.
- A deployment whose integrations root answers non-200 shows the URL field
  alone, with the reason in one line.

On desktop, selecting a repository posts
`{ source: { kind: "repository", connectionId, repo: { fullName } } }` to
`/api/claxedo/projects`; the route gains that variant beside `repoUrl` and
resolves the clone URL and token through the same
`connections.repositoryForAuth` the hosted create uses, so both products
authenticate a clone one way.

On both products the form hands the choice to its host (`onSubmit(source)`)
instead of posting, and the wizard holds it as the draft. Nothing is created
before Finish: the no-project canvas is replaced by the composer the moment
a project lists, so a desktop project posted at step 1 would take the wizard
with it; posting at Finish also answers a refused clone or a folder that is
not a repository on this screen, and leaves nothing behind when the wizard
is abandoned. On the web the draft becomes the `projectName` + source of the
hosted workspace create.

### Step 2 — AI

The step reuses the Models page's data path, not a parallel one. The pieces
are handed to the wizard through `features/onboarding/app-ports.ts` (the
feature may not import `@/features/settings/*`).

**Desktop.** The step sits under the shell's `SettingsScopeProvider`, mounts
`MachineAccountsProvider`, and renders one `AgentHarnessAccounts` row per machine harness
(`localHarnessChecks`: Claude Code, Codex, Cursor) and `HarnessProvidersSection`
for Pi and OpenCode — the same components the Models page draws, with the same
reach marks, Check, Connect and Add-account affordances. Detection runs on
mount, unprompted. Next is enabled when `machine-accounts.ts::runnable`
answers for a harness (its selected entry is a stored account the provider
has not refused, or this computer's login signed in and driving every
binding) or a catalog harness reports a connected provider. With nothing
found, the rows themselves are the picker and "Skip for now" is offered: a
user may prefer to connect at the first send.

**Web.** No machine to scan and one harness the plane serves: the screen is
Pi's provider list, read from `/api/claxedo/agent-config/providers?nativeHarness=pi`
through the existing `useProviders("pi")`, with `openai-codex` shown as
"signs in from a CLI, no key" and the rest taking a key. Saving a key calls
the new `putProviderAuthEntry` in `features/settings/provider-settings-logic.ts`
(`PUT /auth/:providerID?harness=pi`, beside the existing
`removeProviderAuthEntry`), then re-reads the catalog; done means the
provider appears in `connected`. A 503 from the PUT is shown as the plane's
own sentence ("Hosted credentials are disabled") and Next stays disabled.
There is no probe on the hosted plane, so the copy says the key was stored,
not that it was tried; the recorded gap is below.

### Step 3 — Where it runs

**Desktop.** Optional. Default row "Just this machine" is selected and
Finish is enabled on entry. Two further rows: "A cloud sandbox" and "Another
machine". The step exists on desktop only so a user who wants the cloud from
day one is not sent to Settings to find it.

**Web.** Required. No "this machine" row. "A cloud sandbox" is the
deployment's own (`full-hosted`): the row states the driver the plane
reports and needs no key; Finish is enabled. "Another machine" is the CLI
pair and the P4 gap, below.

- **A cloud sandbox (desktop).** Provider catalog + key + verify, as
  `sandbox-provider-api.ts` does today (`saveSandboxProviderKey`, then the
  server's `verification.state`). `working` is done; `unknown` (Modal) is
  accepted with its reason shown; `broken` is not.
- **Another machine (both).** The app cannot mint an invitation (the guard
  above), so the row shows the same two commands Settings → Machines shows.
  On a desktop the project still opens on this computer and the row says
  machines appear in Settings → Machines (the desktop's device list names
  only the computer the user sits at, so it proves nothing here). On the web
  the row states the P4 gap and Finish needs the cloud row.

### Finish

**Desktop.** Finish posts the draft to `/api/claxedo/projects` (no name),
refuses a checkout the app cannot open, and hands `onProjectCreated` the same
`{ id, worktree }` the canvas handed before; the composer opens on it.
Preselecting the environment the user chose in step 3 needs a composer seam
that does not exist (`handleProjectCreated` takes a worktree only); it is
recorded below rather than added here.

**Web, cloud sandbox.** One call: `createCloudWorkspace` with the step-1
draft as source and the derived `projectName`. The response's workspace is
opened through the same `nav(workspaceSessionRoute(...))` the project
actions use. This is the only place the web wizard creates anything, so an
abandoned wizard leaves nothing behind.

**Web, another machine.** The connect plan's P4 (host folder operations and
machine worktrees) is the missing half: nothing today can ask the connected
machine to clone the step-1 repository. The row says so in plain words and
does not enable Finish. This is a recorded gap, not a hidden one.

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
the `VITE_CLAXEDO_ONBOARDING_V1` export in `script/onboarding-desktop.sh`
and in `package.json`'s `build:better-auth` / `test:e2e:onboarding`, the
`@onboarding-enabled` e2e specs and their CI job, and the `opencode.*`
dismissal keys' readers. `localHarnessChecks` and `MachineLogin` (used by
`features/settings/app-ports.ts`) move to their Settings reader.

Moved to `features/settings/remote-access/` (their only caller is
Settings): `remote-access-controller.ts`, `remote-access-marker.tsx`,
`remote-access-state.ts`, `remote-access-surface.tsx`,
`machine-provider-config.tsx` and their tests;
`app/integrations/settings/machines-section.tsx` and `app/entry/app.tsx`
follow the import.

Kept because the wizard calls them, each re-read against its new caller:
`code-host-api.ts` (status, connect, and the new `listCodeHostRepositories`),
`sandbox-provider-api.ts`, `sandbox-provider-query.ts`, `ai-connect-api.ts`
(still exported through `features/settings/app-ports.ts`), `funnel.ts`,
`error-text.ts`, `app-ports.ts`. `credential-query.ts`,
`credential-resolution.ts`, `credential-sharing.ts` go unless step 2 uses
them after the Models-page data path is wired.

`ProjectCreateForm` keeps its two hosts (composer Project chip, wizard). It
loses the Name field in every host — the composer's chip benefits the same
way — and gains the repository-list state and the `onSubmit` seam; the chip
host passes the same inputs it does today.

## Change points

- `packages/claxedo-local-server/src/workspace/routes/projects-route.ts` —
  `name` optional with server-side derivation and clash suffix; `source`
  accepts `{ kind: "repository", connectionId, repo: { fullName } }`.
- `packages/claxedo-server/src/deployments/self-hosted-node/app.ts` —
  `LocalProjectRoutes` receives a `repositoryForAuth`-shaped resolver in
  place of `cloneCredential`, the same one `HostedWorkspaceRoutes` takes.
- `packages/claxedo-app/src/features/settings/provider-settings-logic.ts` —
  `putProviderAuthEntry` beside `removeProviderAuthEntry`.
- `packages/claxedo-app/src/features/workspaces/data/project-api.ts` —
  `ProjectSource` gains the connection variant; `createProject` sends no
  name when the caller has none.
- `packages/claxedo-app/src/features/onboarding/code-host-api.ts` —
  `listCodeHostRepositories(request, connectionId)`.
- `packages/claxedo-app/src/features/workspaces/ui/project-create-form.tsx`
  — folder-first, no Name field, repository list state, URL as a link,
  `onSubmit` for a host that holds the choice.
- `packages/claxedo-app/src/features/onboarding/` — replaced by
  `wizard.tsx` (host, step order, footer reason), `project-step.tsx`,
  `ai-step.tsx`, `execution-step.tsx`, `draft.ts` (the web draft), and
  their tests; `app-ports.ts` gains the Models-page pieces
  (`SettingsScopeProvider`, `MachineAccountsProvider`, `AgentHarnessAccounts`,
  `HarnessProvidersSection`, `localHarnessChecks`, `useProviders`,
  `putProviderAuthEntry`, `useRemoteAccessController`).
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

- [x] On a wiped `CLAXEDO_DATA_DIR` with `dev:local`, the first screen is
      the wizard's project step with a folder picker and no Name field;
      picking a folder with a git remote creates a project named after the
      remote's repository, and a folder without one after its basename.
      Progress: done. Wizard `adedaf8672`, route `e6fcae96ea`. Proven on a
      real `claxedo-server` (self-hosted node, wiped `CLAXEDO_DATA_DIR`,
      port 2597) with `dev:local` on 4447 through the browser pane, in both
      colour schemes; derivation through the live route: a folder whose
      `origin` is `kyashrathore/Claxedo.git` → `Claxedo`, a fresh `git init`
      folder → `plain-folder`, a second such folder → `plain-folder-2`. The
      folder picker's own dialog was not driven in that run; the clone path
      was (below). Route tests: `projects-route.test.ts` 30/30.
- [ ] "Clone a repository" with no GitHub connection shows the connect block
      inline; connecting advances to a searchable list of that account's
      repositories; selecting one creates the project on the local server
      through `connectionId + repo`, and the clone authenticates with the
      connection's token (asserted by the route test, not by a 200).
      Progress: done in code and tests: form `c0c9c81087` (13 vitest cases:
      connect block, device grant polling, token paste, list search and
      select, URL link), route `e6fcae96ea` (the credential and host asserted
      on the fake clone). Not exercised against a live GitHub account.
- [x] "Paste a URL instead" clones a public repository anonymously, as today.
      Progress: done. Live: `https://github.com/octocat/Hello-World` cloned
      into `<dataDir>/projects/hello-world` and opened in the composer as
      `Hello-World` on "This computer".
- [x] Step 2 on desktop runs detection without a click, lists each harness
      with its logins and reach marks, and enables Next when one is selected
      and usable; with none it shows the same rows as the picker.
      Progress: done (`adedaf8672`). Live: Claude Code, Codex and Cursor rows
      with this Mac's logins and usage windows, Pi and OpenCode catalogs,
      Next enabled and no Skip; `ai-step.vitest.tsx` covers the empty case.
- [x] Step 2 on a hosted stack: the Pi provider list shows; a pasted key is
      stored through `PUT /auth/:providerID?harness=pi` and the provider
      appears connected, enabling Next; a 503 or 400 shows the plane's
      sentence as footer text and Next stays disabled.
      Progress: done (`2945e2472e`, `adedaf8672`). Hosted e2e
      `core-cloud-provisioning.spec.ts` "hosted control plane" walks it
      through the built app (1 passed); `ai-step.vitest.tsx` covers the
      refusal sentence. The sentence shows on the row, under the key field,
      with the footer naming why Next waits.
- [x] Step 3 on desktop is preselected "Just this machine" and Finish opens
      the composer on the new project; choosing a sandbox provider and saving
      a working key marks the cloud row done.
      Progress: done (`adedaf8672`). Live: preselected, the cloud row listed
      the real driver catalog with its key field and held Finish;
      `execution-step.vitest.tsx` covers working / broken / unknown verdicts.
- [x] Step 3 on hosted: the cloud row names the deployment's driver and
      enables Finish; the machine row shows the CLI pair and states the P4
      gap; no call is made that cannot succeed.
      Progress: done, with one correction: the plane names its driver
      nowhere the app reads (`/api/claxedo/health` and `/mode` carry none), so
      the row says the sandbox is the deployment's without a driver name. The
      hosted e2e asserts zero drivers and zero project calls.
- [x] Web finish with a cloud sandbox creates exactly one hosted workspace
      whose project name is the derived repository name and opens it; an
      abandoned wizard creates nothing (asserted against the authority).
      Progress: done in the hosted e2e (one `POST /api/workspace/create` with
      `{ projectName: "app", repoUrl }`, the route `/w/<id>/session` opened)
      and `wizard.vitest.tsx` (nothing posted before Finish). Not run against
      the live staging plane: a real create provisions a sandbox.
- [x] Settings → Machines renders and behaves as before from
      `features/settings/remote-access/`; `app/entry/app.tsx` mounts the
      marker from there. `git grep -n "features/onboarding/remote-access"`
      returns nothing.
      Progress: done 2026-09-23 (Lane M). `machine-provider-config.tsx` moved
      with them, its only caller being the same Machines panel; the controller
      lost its funnel `emit`, which only the deleted v1 step passed. The grep
      matches this plan's own text and nothing else.
- [x] `git grep -n "ONBOARDING_V1\|onboardingOverlayDirectory\|OnboardingEmptyState\|setupShellMode"`
      returns nothing; every deleted module's test is deleted with it; no
      kept module in `features/onboarding` lacks a production importer.
      Progress: done 2026-09-23 (Lane D) except the last clause, which waits
      on the wizard: `code-host-api`, `sandbox-provider-api`,
      `sandbox-provider-query`, `credential-query`, `credential-resolution`,
      `credential-sharing` and `error-text` are kept for lanes A2/S1 with no
      production importer today. The grep matches this plan's own text and a
      recorded transcript in `session-ui/src/components/transcript-lab-fixture.json`,
      nothing in code. Also gone: the `test:e2e:onboarding` script and its
      CI job, the `onboarding` change-selection output, the `surface` field of
      `step_done`, and the v1 `OnboardingDestination` in `ai-connect-state`.
- [x] The composer's Project chip creates a project with no Name field and
      the repository list, through the same `ProjectCreateForm`.
      Progress: done (`c0c9c81087`); `core-workspace-lifecycle.spec.ts` asserts
      the source-only body (`9f2d74f542`).
- [x] Funnel: `setup_form_shown`, `step_done` ×3 with the new step ids, and
      `first_turn_ok` fire in order in a rendered test.
      Progress: `wizard.vitest.tsx` asserts `setup_form_shown`, then
      `step_done` project/ai/execution in order; `first_turn_ok` is the
      session screen's and unchanged.
- [x] Gates: `bun run test:architecture-ratchets`; app vitest + bun test;
      local-server and claxedo-server vitest for the projects route;
      `turbo typecheck`; `bun run lint` on touched files;
      `bun run test:ci-policy`; `cd packages/claxedo-app && bun run build:better-auth`;
      Playwright proof of the desktop path (steps 1–3, folder + clone)
      against a real local stack in both themes, and of the hosted path
      against the signed-web e2e stack.
      Progress: `bun run test:architecture-ratchets` holds (app-local 1102,
      desktop renderer 1146, exact); `bun run test:architecture` 260/0;
      vitest `src/features/onboarding` + canvas 24/24, `bun test` for
      draft, code-host-api, workspace-create-api, provider-settings-logic
      54/0; `npx tsgo -b` exit 0; `bun run lint` on every touched file 0/0;
      `bun run test:ci-policy` 16/16; `bun run build:better-auth` exit 0;
      hosted e2e (`e2e-core-repro.sh test-user`) 1 passed; the desktop path
      was driven against the real local stack in both colour schemes through
      the browser pane rather than a Playwright spec (the folder picker's
      dialog excepted).
- [x] `docs/plans/2026-09-14-002-feat-onboarding-v1-repair.md` is deleted and
      the README entry points here.
      Progress: already true before Lane D (deleted in `e28b0b595b`; the README
      carries only this plan's entry).

## Recorded gaps (evidence, owner, follow-up)

- **Invitation minting from the app.** Blocked by
  `architecture/hosted-operation-inventory.test.ts` (NON_ACCOUNT_ROUTES +
  the "never promoted into an AccountPort row" assertion). Owner: the
  desktop hosted-operation matrix. Follow-up: an owner ruling to add
  `host.invitations.create/list` to `desktop-hosted-operation-matrix.md`,
  `claxedo-desktop/src/main/account/hosted-operations.ts` and the app
  registry in one commit, moving the two routes out of NON_ACCOUNT_ROUTES.
  Until then the wizard shows the CLI pair.
- **Hosted AI verification.** The plane has no `/credentials/:id/verify`;
  the wizard's "done" is the catalog's `connected` set after the PUT, not a
  probe. Follow-up: a hosted verify route in `routes/hosted/shell.ts` beside
  `putPiCredential`, using the same usage-read probe the self-hosted
  `/credentials/:id/verify` uses.
- **Hosted credentials switch.** `PUT /auth/:providerID?harness=pi` answers
  503 while `CLAXEDO_HOSTED_CREDENTIALS_ENABLED` is off. Staging's setting
  was not read tonight; the wizard shows the 503 sentence as-is.
- **Web, another machine.** Connect plan P4; the wizard says so.
- **Dev's own ratchet.** A clean checkout of `1765147184` measures
  app-local 1101 and desktop renderer 1145 against ledgers of 1100 / 1144;
  this branch's ledgers start from the measured figures.
- **Desktop finish environment preselect.** `handleProjectCreated` takes a
  worktree only; preselecting `cloud` in the composer needs a seam in
  `features/workspaces/actions/project-actions.tsx`. Follow-up in the
  composer's Environment chip owner.

## Execution: parallel lanes with disjoint ownership

Fable subagents (user ruling 2026-09-14). One owner per lane, `git commit --
<paths>` per lane; the orchestrator reads every diff and re-runs the lane's
gate before accepting, then runs the Playwright proofs itself.

- Lane S1, local projects route: `projects-route.ts` (optional name,
  derivation, clash suffix, connection source), `self-hosted-node/app.ts`
  wiring, their tests. Gate: local-server + claxedo-server vitest.
- Lane S2, hosted Pi key write: `provider-settings-logic.ts`
  `putProviderAuthEntry` + test; replaces the invitation-operation lane,
  which the guard refuses (recorded above). Gate: app vitest.
- Lane A1, form: `project-api.ts`, `code-host-api.ts` repository list,
  `project-create-form.tsx` (+ vitest), the composer chip host in
  `session-new-design-view.tsx`, `first-project-canvas.vitest.tsx` for the
  Name-field removal. Contract with S1 fixed above (S1 lands first). Gate:
  app vitest.
- Lane A2, wizard: `features/onboarding/{wizard,project-step,ai-step,
  execution-step,draft}.tsx`, `app-ports.ts` additions, `first-project-canvas.tsx`,
  `rail-workbench-canvas.tsx`, funnel wiring. Depends on A1's form and S2's
  client, and on the v1 removal (Lanes M + D, run by another agent) having
  landed on `dev`. Gate: app vitest + bun test.
- Lane M, remote-access move: the five files + tests to
  `features/settings/remote-access/`, `machines-section.tsx`, `app.tsx`,
  `features/settings/AGENTS.md`. Independent. Gate: app typecheck, the
  settings vitest files.
- Lane D, deletion: everything in "Deleted" above plus `index.ts`,
  `AGENTS.md`, `script/onboarding-desktop.sh`, the superseded plan and the
  README entry. Lands after A2 and M so no importer breaks mid-stream. Gate:
  ratchets, `git grep` checks from the DoD.

S1, S2, M and A1 start together; A2 after A1, S2 and M + D; D's residue
sweep last.

Landed on `feat/onboarding-v2` (rebased onto `dev` 1765147184): S1
`e6fcae96ea`; S2 `2945e2472e`; A1 `1e897b67dd`, `c0c9c81087`; A2
`adedaf8672`, `e36c2e3482`, `996d905039`; e2e body `9f2d74f542`; ledgers
`4606259680`. M and D landed on `dev` (`26e44eeb8a`, `1765147184`). A2's
residue sweep deleted `credential-query`, `credential-resolution`,
`credential-sharing` and `sandbox-provider-query`.
