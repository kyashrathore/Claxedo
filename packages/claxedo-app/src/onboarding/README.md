# Onboarding

Owns: the first run. Today's app's first-project canvas and its three-step wizard (Project, AI, Where it runs), shown when the server lists no project.

## Concepts

- **Route entry**: `onboardingRoute`, the shell `RouteEntry` for `/welcome`, listed in the shell's `routes` registry. `FirstProjectCanvas` is its view: the kit's `ArtworkPlate` behind the wizard column, faded under the card.
- **Needed?**: `onboardingNeeded(projects, sharedSessions)` is true when the project list is ready and empty and the account's shared-session list has been read and is empty too; a person with only shared sessions stays in the shell, where the rail lists them. The shell's home route sends the reader to `onboardingPath` when it is.
- **Product**: the wizard waits for `server.capabilities()`. A server that declares `thisMachine` is a desktop (local execution); any other is a hosted plane. Ledes, step 2, step 3's rows and the finish button follow that.
- **Execution facts** (`model.ts`): `localExecution` (a desktop), `cloudAvailable` (the reader is signed in to a control plane, `useAuth()`) and, on a server without `thisMachine`, `machineConnected` (an enrolled machine in `queries.machines.list()`). `executionChoices` lists step 3's rows from them; `executionPlan` turns the choice and the typed name into `local` or `cloud(name)`; `executionBlock` says why the plan cannot finish: `signIn` (cloud without a signed control plane), `folder` (cloud from a local folder, which no cloud workspace can clone) or `name` (a cloud workspace needs a name).

## State

`createOnboardingWizard` (`wizard.ts`) holds the current step, the visited steps, the draft (`{source, name?}`), step 2's readiness, the step 3 choice with the cloud workspace's name, and the finish machine. Step 3's readiness is derived from the execution facts, the plan and the draft. Nothing is written before Finish.

- The route requires sign-in (`requiresSignIn`): on a signed server the shell sends a signed-out reader to `/login` before anything reads Connections or accounts.
- Step 1 is `ProjectCreateForm` from `@/projects` with `submitLabel` Continue; its submit stores the draft and moves to step 2. Without local execution it offers only a connected code-host repository (`connectedRepositoryOnly`): connect GitHub, then pick; a failed Connections read stays visible with Retry. It has no Name field there, because the control plane names the project after the repository.
- Step 2 is `AgentHarnessAccounts` from `@/accounts` for each harness, the same cards Settings → Models shows, and reports whether one login can run a turn. Machine logins are read only on the machine the harnesses run on, when this step first opens, because that read starts the harness CLIs; the web shows the same cards over its stored accounts. The provider chooser offers Pi and OpenCode on a machine and Pi on the web.
- Step 3 offers Just this machine (desktop, preselected) and A cloud workspace (only with `cloudAvailable`), whose required Name field names the workspace. "Another machine" is not offered: nothing can send a new project to a connected machine. On the web with no connected machine, "This computer — connect it" opens the add-a-machine steps Settings → Machines shows (`MachineConnectSteps` from `@/settings`); a connected computer's folders then arrive as projects.
- Finish (`place.ts`) on a desktop that keeps this machine creates the project (`createOrOpenFolderProject`: a folder that already is a project opens that project) and opens the draft of its folder placement at `/w/<placement>/session`. A cloud choice, on a signed desktop or on a hosted plane, creates the cloud workspace with its name from the repository through the signed account (`server.cloud.create({ source, name })`), whose control plane derives the project, starts it (`startCreated`, so the first screen is live and its models load) and opens the workspace's draft.

## Finish machine

`createFinish` (`finish.ts`) runs Finish as an `@/lib/flow` flow, `creating` then `opening`, beside `created`: what Finish has made so far, a `project` or a `workspace` (`model.ts`). A failure keeps `created`, and the next click runs the flow again.

- A retry continues from `created`: it never creates what already exists, and with a project or workspace in hand it only opens it. A cloud workspace is held the moment the account's create answers (`create(hold)`, through `cloud.create`'s `onCreated`), before the catalog read that can still fail, so a failure there is retried by opening it.
- A failure after the project or workspace exists reads "Created successfully, but could not open it: …" and the button reads Open created project / Open created workspace.
- Once anything is created, Back is disabled and step 3's panel is inert; after `finished` the button stays disabled.
- A move (Back, Next) clears a failure only while nothing is created.

## Rules the view keeps

- The canvas scrolls only when the window is shorter than headline, lede and card footer; otherwise only the card body scrolls.
- The card animates its height between steps (`animateHeightChanges` from `@/ui`, off under `prefers-reduced-motion`).
- Back keeps state: visited step panels stay mounted and hidden, and any move clears the failure line.
- Step 1 has no footer; steps 2 and 3 show the reason line, Back, Skip for now (step 2, desktop, not ready), then Next or the finish button.

## Flows

- Flow 1 (`e2e/flows/01-first-run.spec.ts`): first run on an unsigned machine: choose a folder, see the accounts, keep Just this machine, open the project, first prompt. It runs on the local web in both apps.
