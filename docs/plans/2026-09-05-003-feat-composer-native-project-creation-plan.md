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

- [ ] Create a project from a folder (local server) and from a repository URL (any server) through the
      composer chip; both appear in the rail without any execution.
- [ ] Repository-backed project + Local → first submit clones into the server's projects directory and
      starts a session there; + Cloud → provisions a sandbox with the project's environment.
- [ ] Environment lives on the project; a second sandbox for the same project receives it.
- [ ] Hosted plane: same contract on D1.
- [ ] No New Project dialog remains; the three flows have tests at the rule level and the route level.

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

