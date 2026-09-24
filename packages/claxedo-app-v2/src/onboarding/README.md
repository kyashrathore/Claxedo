# Onboarding

Owns: the first run. Today's app's first-project canvas and its three-step wizard (Project, AI, Where it runs), shown when the server lists no project.

## Concepts

- **Route entry**: `onboardingRoute`, the shell `RouteEntry` for `/welcome`, listed in the shell's `routes` registry. `FirstProjectCanvas` is its view: the blueprint field, glow and vignette behind the wizard column.
- **Needed?**: `onboardingNeeded(projects)` is true when the project list is ready and empty. The shell's home route sends the reader to `onboardingPath` when it is.
- **Product**: the wizard waits for `server.capabilities()`. A server that declares `thisMachine` is a desktop (local execution); any other is a hosted plane. Ledes, step 2, step 3's rows and the finish button follow that.

## State

`createOnboardingWizard` (`wizard.ts`) holds the current step, the visited steps, the draft (`{source, name?}`), each step's readiness, the step 3 choice and the finish state. Nothing is written before Finish except a sandbox provider key saved in step 3.

- Step 1 is `ProjectCreateForm` from `@/projects` with `submitLabel` Continue; its submit stores the draft and moves to step 2.
- Step 2 lists the account cards per harness and reports whether one login can run a turn. Machine logins are read only when this step first opens, because that read starts the harness CLIs.
- Step 3 offers Just this machine (desktop, preselected), A cloud sandbox (a desktop saves a provider key through `server.sandboxProviders`) and Another machine (the two CLI commands).
- Finish on a desktop creates the project (`createOrOpenFolderProject`: a folder that already is a project opens that project) and opens the draft of its folder placement at `/w/<placement>/session`. On a hosted plane it creates the project and its first cloud workspace, then opens that workspace's draft. A failure is shown in the footer's reason line.

## Rules the view keeps

- The canvas scrolls only when the window is shorter than headline, lede and card footer; otherwise only the card body scrolls.
- The card animates its height between steps (`animateHeightChanges` from `@/ui`, off under `prefers-reduced-motion`).
- Back keeps state: visited step panels stay mounted and hidden, and any move clears the failure line.
- Step 1 has no footer; steps 2 and 3 show the reason line, Back, Skip for now (step 2, desktop, not ready), then Next or the finish button.

## Flows

- Flow 1 (`e2e/flows/01-first-run.spec.ts`): first run on an unsigned machine: choose a folder, see the accounts, keep Just this machine, open the project, first prompt. It runs on the local web in both apps.
