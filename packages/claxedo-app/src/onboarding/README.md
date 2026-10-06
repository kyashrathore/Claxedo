# Onboarding

Owns: the first run. Today's app's first-project canvas and its three-step wizard, shown when the server lists no project. A desktop asks Project, AI, then Where it runs; a hosted plane asks Where it runs first, then Project and AI, so the cloud provider is settled before a cloud workspace is offered.

## Concepts

- **Route entry**: `onboardingRoute`, the shell `RouteEntry` for `/welcome`, listed in the shell's `routes` registry. `FirstProjectCanvas` is its view: the kit's `ArtworkPlate`, `thinned` to 30 % of its dots around the card, behind the wizard column.
- **Needed?**: `onboardingNeeded(projects, sharedSessions)` is true when the project list is ready and empty and the account's shared-session list has been read and is empty too; a person with only shared sessions stays in the shell, where the rail lists them. The shell's home route sends the reader to `onboardingPath` when it is.
- **Product**: the wizard waits for `server.capabilities()`. A server that is itself a machine (`localExecution`) is a desktop; any other is a hosted plane. The step order (`onboardingSteps(localExecution)`, `steps.ts`), the ledes, the AI step, the Where step's rows and the finish button follow that.
- **Execution facts** (`model.ts`): `localExecution` (a desktop), `machineName` (the serving machine's name, `server.capabilities().servingMachine`, read from the bootstrap), `cloudAvailable` (the reader is signed in to a control plane, `useAuth()`) and `machineConnected` (an enrolled machine in the same list). `executionChoices` lists the desktop Where step's rows from them; `executionPlan` turns the choice, the workspace name and the chosen machine size into `local` or `cloud(name, machineClass?)`; `executionBlock` says why the plan cannot finish: `signIn` (cloud without a signed control plane) or `folder` (cloud from a local folder, which no cloud workspace can clone). The cloud workspace is named after the project (`draftName`: the typed name, else the repository's last segment), so no step asks for a name.

## State

`createOnboardingWizard` (`wizard.ts`) holds the current step, the visited steps, the draft (`{source, name?}`), the AI step's readiness, the Where choice with the machine size (`createMachineSizeChoice` from `@/cloud`, hosted only), and the finish machine. Whether Finish may run (`blocked`) is derived from the execution facts, the plan, the draft and, on a hosted plane, the AI step's readiness. Nothing but the organization's provider choice is written before Finish.

- The route requires sign-in (`requiresSignIn`): on a signed server the shell sends a signed-out reader to `/login` before anything reads Connections or accounts.
- The Project step is `ProjectCreateForm` from `@/projects` with `submitLabel` Continue; its submit stores the draft and moves on. Without local execution it offers the same two entries as Create project, as a segmented control: From GitHub (connect GitHub, then pick) and Paste URL (a public repository by its URL, cloned without a GitHub connection); a failed Connections read stays visible with Retry; where no code host is offered it asks for the repository URL alone. It has no Name field there (`namedByRepository`), because the control plane names the project after the repository.
- The AI step is `AgentHarnessAccounts` from `@/accounts` for each harness, the same cards Settings → Models shows, and reports whether one login can run a turn. Machine logins are read only on the machine the harnesses run on, when this step first opens, because that read starts the harness CLIs; the web shows the same cards over its stored accounts. The provider chooser offers Pi and OpenCode on a machine and Pi on the web. The wizard prefetches the stored accounts (and, on a hosted plane, the Connections catalog) when it mounts, so the later steps open on data already read.
- The Where step on a desktop offers one row for the serving machine, named by the machine (preselected), and A cloud workspace (only with `cloudAvailable`). On a hosted plane it is `CloudPlacement` (`view/cloud-placement.tsx`), the first step: where cloud workspaces run, read from `useSandboxKeys()` (`@/accounts`, the same listing Settings → Models' Sandbox group shows). With no organization key the one row is "Claxedo's machines", the deployment's managed driver; with keys, one row per keyed provider, checked when it is the driver new workspaces get, and choosing one writes the organization's choice (`store.choose`). "Add your provider key…" opens the Sandbox group's `DrawerSandboxKey`; a reader who may not manage keys sees one line naming the provider in use. `MachineSizeField` follows when the provider declares sizes. Another connected machine is not offered: nothing can send a new project to a connected machine; its folders are added on it and arrive as projects. On the web with no connected machine a quiet "Connect a machine…" action opens Settings → Machines' instructions drawer (`useConnectMachine` from `@/settings`).
- Finish (`place.ts`) on a desktop that keeps its own machine creates the project (`createOrOpenFolderProject`: a folder that already is a project opens that project) and opens the draft of its folder placement at `/w/<placement>/session`. A cloud choice, on a signed desktop or on a hosted plane, creates the cloud workspace with the plan's name and machine size through the signed account (`server.cloud.create({ source, name, machineClass })`), whose control plane derives the project, starts it (`startCreated`, so the first screen is live and its models load) and opens the workspace's draft.

## Funnel

`createOnboardingFunnel` (`funnel.ts`) records the wizard's product events: `onboarding_step_viewed` for the first step and every step moved to, `onboarding_step_completed` for a step left forward and for the last step when Finish opens what it made, and `onboarding_abandoned` with the current step when the wizard unmounts unfinished. A closed tab unmounts nothing and records nothing.

## Finish machine

`createFinish` (`finish.ts`) runs Finish as an `@/lib/flow` flow, `creating` then `opening`, beside `created`: what Finish has made so far, a `project` or a `workspace` (`model.ts`). A failure keeps `created`, and the next click runs the flow again.

- A retry continues from `created`: it never creates what already exists, and with a project or workspace in hand it only opens it. A cloud workspace is held the moment the account's create answers (`create(hold)`, through `cloud.create`'s `onCreated`), before the catalog read that can still fail, so a failure there is retried by opening it.
- While a created cloud workspace opens, the reason line reads what its start waits for (`openingDetail` over `server.cloud.runtime`: "Starting the machine, about a minute", "Resuming the machine", "Restoring files"), so Opening… is never a bare spinner.
- A failure after the project or workspace exists reads "Created successfully, but could not open it: …" and the button reads Open created project / Open created workspace, which runs the open again.
- Once anything is created, Back is disabled and step 3's panel is inert; after `finished` the button stays disabled.
- A move (Back, Next) clears a failure only while nothing is created.

## Rules the view keeps

- The canvas scrolls only when the window is shorter than headline, lede and card footer; otherwise only the card body scrolls.
- The card animates its height between steps (`animateHeightChanges` from `@/ui`, off under `prefers-reduced-motion`).
- Back keeps state: visited step panels stay mounted and hidden, and any move clears the failure line.
- The footer shows the reason line, Back (not on the first step), Skip for now (the AI step, desktop, not ready), then Next, or the finish button on the last step. The Project step's own Continue stands in for Next, so a Project step that comes first has no footer at all.

## Flows

- Flow 1 (`e2e/flows/01-first-run.spec.ts`): first run on an unsigned machine: choose a folder, see the accounts, keep the machine's own row, open the project, first prompt. It runs on the local web in both apps. Its web case runs the hosted order: Claxedo's machines checked and the provider key offered, Connect a machine, then the repository, the AI, and the workspace named after the repository.
