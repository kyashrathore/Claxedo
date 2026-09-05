# Composer-native project creation

**Status:** planned · 2026-09-05
**Owner:** codex/refactor-agent-plugins branch
**Supersedes:** the New Project dialogs from `2026-09-05-002` (cloud onboarding dialog, folder/cloud chooser)

## The model (owner, 2026-09-05)

A **project** is a repository and a name. A **workspace** is where that project executes: a
local worktree on a machine with a filesystem, or a cloud sandbox on a provider. Creating a
project never asks where it will run. Execution is chosen when work starts, in the draft
composer, exactly as today's Environment and Workspace chips already do.

There is no New Project dialog. The draft composer is the one surface:

1. **Project chip** lists projects and ends with **Create project…** (the chip's existing
   `action` slot, today "Add project"). Creating asks for a **name**, then a **location**:
   - a **folder on this machine**, offered when the server has a filesystem (`localExecution`
     from its health document) — the existing directory picker;
   - a **git repository**: a connected GitHub repository or a URL (the existing repository
     picker, with Connect GitHub inside).
   A project made from a folder is local by construction. A project made from a repository
   has no execution yet.
2. **Environment chip** offers Local when the server has a filesystem and Cloud when a
   sandbox provider exists. For a repository-backed project the default is Local when Local
   is offered, else Cloud. Today the option list keys off `platform === "web" && signed`;
   it keys off the server's `localExecution` instead.
3. **Workspace chip** is unchanged: main / worktrees / "Create new worktree" / "New cloud
   sandbox". Submitting a draft with Cloud + create provisions the sandbox from the project's
   repository (`submit-directory.ts` → `createCloudWorkspace(plan.projectId)`); submitting
   with Local on a repository-backed project that has no local checkout first clones it into
   the server's projects directory (new server route), then continues as a local worktree.
4. **Environment variables** are a project setting (the project edit dialog, next to the
   worktree startup command), applied to every cloud sandbox of that project at provision.
   They move off the workspace record where `2026-09-05-002` put them.

## Slices

- S1 — Server: `POST /api/workspace/projects` creates a project from `{ name, repoUrl | connectionId+repo | directory }`
  without executing anything; repository-backed projects get a local checkout lazily via
  `POST /api/workspace/projects/:id/checkout` (clone into `<dataDir>/projects/<slug>`) when a Local
  workspace is first requested. Project environment stored on the project (`project_env`), read at
  cloud provision; the workspace-level `env` from 2026-09-05-002 is removed.
- S2 — Composer: Project chip "Create project…" → name → location (folder | repository) inline in the
  chip's popover; Environment options from `localExecution` + provider availability; default rule.
- S3 — Remove `DialogNewProjectKind`, the web-only `DialogCreateCloudProject` onboarding sections that
  duplicate the chip flow (keep its repository picker and provisioning log as shared pieces), and the
  New Project branches in `home.tsx` / `project-actions.tsx`; the rail's New Project button opens a
  draft composer with the Project chip's create flow expanded.
- S4 — Project settings: environment editor in `dialog-edit-project.tsx`; hosted plane persists it on
  the project row.

## Definition of done

- [x] Create a project from a folder (local server) and from a repository URL (any server) through the
      composer chip; both appear in the rail without any execution. (Live on the signed local web app,
      2026-09-05; see execution log.)
- [x] Repository-backed project → the create route clones into the server's projects directory and the
      composer opens the checkout locally (live). + Cloud → `startCloudWorkspaceProvisioning` receives
      the project's environment (route test `workspace/routes/index.test.ts`; not exercised live).
- [x] Environment lives on the project; cloud provisioning and the supervisor read `projectEnv(project_id)`
      (route + supervisor call sites; the second-sandbox case is covered at the route level only).
- [ ] Hosted plane: same contract on D1. (Next slice; the D1 `projects` table has no env column yet.)
- [x] No New Project dialog remains anywhere. The empty canvas mounts the same composer chip row
      (`NewSessionDesignView` with no project; the chip reads "Select project") and the rail's "New
      Project" only raises `layout.projects.requestCreate()`, which the mounted composer's Project
      chip answers by opening its create panel. Tests:
      `session-new-workspace-options.test.ts` (rule), `projects-route.test.ts` (route, 11 cases),
      `session-new-design-view*.vitest.tsx` (chip panel + environment options).

## Execution log (2026-09-05)

Built and verified on the signed local web stack (`claxedo-server-embedded-auth` :2597 behind Vite TLS
:4449, fixture user) with a Playwright Chromium driver against the real dev server (the in-app browser
refuses the self-signed origin). Flows proven live, in order:

1. Rail "New Project" → create dialog → **Select project** opens the server's directory browser
   (lists the machine's folders) → the dialog resumes the draft after the picker → 201 → the composer
   opens the new project.
2. Composer Project chip → "Create project…" panel → Select project (the popover holds open under the
   picker) → 201 → the chip switches to the new project.
3. Panel → "Clone a repository instead" (top-right text switch) → repository URL → clone under
   `<dataDir>/projects/<slug>` → the chip switches to the clone within ~5 s.
4. Duplicate name → 409 shown in the form. Environment chip lists Local and Cloud.
5. Rail row → Edit → environment variables saved (`PATCH /api/claxedo/projects/:id`) and shown again
   on reopen.

Defects found and fixed on the way (each with a test):

- Signed server + local folder: every engine call 503'd (`Signed runtime proxy requires a verified
  actor`) because `resolveRelayActor` authorises against authority workspace membership and folder
  projects had no authority row. The create route now registers the workspace through
  `registerLocalForSharing` (backing `local-worktree`, access `user-hosted`) as the signed caller;
  `controlPlaneRouteAuth` keeps the verified context for handlers (`signedRouteAuth`).
- Directory picker gated on a loopback **http** URL, so on `https://localhost` it listed nothing; it
  now asks the server's health (`localExecution`).
- The chip popover dismissed itself when the picker dialog took focus; `ContextChip.panel.render`
  gained `hold()`.
- The dialog host shows one dialog at a time, so the picker replaced the create dialog; the dialog
  re-shows itself with the draft after the picker.
- Creating a project over a folder that already is one renamed the existing project; now 409.
- A private GitHub repository clones with the caller's connected GitHub account
  (`connectionsHost.service.getToken(id, "code-host")`, header via `GIT_CONFIG_*` env, never argv).

Known, not in this slice: `GET /session/new/subagents?directory=…` answers 403 ("Private session
authority denied access") for a folder project on the signed server; the hosted plane env column.

## Open decisions (owner)

- Where local checkouts of repository-backed projects live (`<dataDir>/projects/<slug>` proposed).
- Whether a project may be renamed after creation and whether the name must be unique per server.

## Code facts that shape S2 (2026-09-05)

- A draft session is always keyed by a directory: `layout.openSession(directory, "new", …)`, and the
  empty-canvas composer (`EmptyDraftSessionComposer`) is rendered for `emptyDraftDirectory()` =
  the active directory, else the first project's worktree (`rail-empty-draft-controller.ts`). With
  no projects at all there is no draft: the canvas shows `OnboardingEmptyState` (behind
  `VITE_CLAXEDO_ONBOARDING_V1`, now on) or the legacy empty state, both with a New Project button.
  So "Create project" in the Project chip covers every state except the very first project, which
  the empty state's New Project button must open as the same create flow (a composer with the chip
  expanded, no directory yet).
- The Project chip's "Add project" action is the `claxedo-project` command
  (`ADD_PROJECT_COMMAND_ID` → `actions.handleNewProject()`), i.e. today's New Project flow; the chip's
  `onProjectChange` navigates to the chosen project's workspace route, which opens a fresh draft
  there. Creating a project therefore ends by navigating to it, not by mutating the current draft.
- The project's startup command lives in the project's Edit dialog (rail project kebab → Edit →
  "Runs after creating a new workspace (worktree)") and is persisted through the engine's project
  update (`Project.Commands`, `PATCH /project/:id`). The environment editor joins it there.

Owner correction (2026-09-05, late): the dialog host for the rail / empty canvas was wrong — "a
session composer UI, exact same". Replaced by the composer chip row on the empty canvas plus the
create intent on the layout's projects API (`createLayoutProjectsApi`, split out of `layout.tsx`).
Proven live from a wiped store: empty canvas → chip "Select project" → rail "New Project" opens the
chip panel → Select project → create → lands in the new project's draft. The full draft pane
(prompt input included) still needs a project directory for its provider chain; a project-less
draft pane is a separate slice (the pane suspends forever inside a transition without one).

Follow-up (2026-09-05, late): a tab whose persisted workbench state (localStorage `claxedo.state.v5`)
still held a pane for a wiped workspace restored it as a live draft: every directory request 404'd,
the events stream reconnected, the bootstrap repeated (10k+ console errors, `/api/workspace` rate
limited to 429). `applyStaleWorkspaceSweep` (`app-shell-route-sync.ts`, mirrors the access-revocation
sweep) now closes session surfaces the loaded inventory does not know and sends an active one to `/`.
Proven with a saved browser state against a wiped server: the pane closes, the URL lands on `/`, two
initial 404s, then quiet. Note: a directory that still exists on disk is re-registered by the server
on first touch (directory-shaped routing), so the sweep only fires once the folder is really gone.
