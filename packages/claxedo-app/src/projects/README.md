# Projects

Owns: the project as the app sees it, its placements, the create-project form (the composer's Project chip and the first run's step 1), Settings → Projects (v1's Edit dialog and remove), v1's project list data for the rail, and the routes that name a project or a placement by id.

## Concepts

- **Project** (`Project` from `@/server`): one daemon record from `/api/claxedo/projects`, or one account project grouped from the hosted workspace catalog. A signed browser connected to the Worker reads account projects exclusively. On a signed desktop, the adapter adds the account's control-plane projects that share no workspace with a local project (the link rule is in `src/server/README.md`). The route lists every project v1 lists, with v1's name, icon, colour and startup command, its environment, its source, its checkout `directory` (display only), `available`, false when none of its placements exists any more (a stopped cloud sandbox still counts), and `missingCheckout` when the project's own folder on this server is gone: that folder and the remote it was registered with. Removing a project removes it and its placements everywhere.
- **Rail list** (`createProjectList`, `ProjectListProvider`): v1's sidebar data, the route's projects in this browser's order with their colours, persisted per server as v1 did (`project-state.ts`, keyed by project id). New projects join at the end in v1's catalog order, by project id (`project-order.ts`), which is also a fresh browser's whole order. A project without a colour gets a free one (`project-colors.ts`), saved through the daemon route when `server.projects.configurationAvailable()` reports it is served; on hosted, the color remains a browser preference.
- **Placement**: where a project runs, a folder, a worktree or a cloud workspace (`Placement`). A placement has its own id; a session belongs to one placement. A folder path is display data, never a key, a route parameter or an identity. Only `src/server/` turns a placement into a directory.
- **Source**: what the project is made from, a repository URL, a repository from a connected code host, or a folder on a machine. A folder is offered only when the server reports `thisMachine`.
- **Draft** (`ProjectDraft`): the answers the add flow collects (name, source, harness, and the reader's explicit placement pick) before anything is created.
- **Placement options** (`placement-options.ts`): the machines and the cloud a new project could run on, derived from `capabilities()`, `queries.machines.list()` and the source. The flow's `placement()` is the explicit pick while it is still selectable, otherwise the first selectable option; nothing writes that default back into the draft.

## Data

`store.ts` reads through the adapter's query options and exposes machines, never raw queries:

| Hook | Home | State |
| --- | --- | --- |
| `useProjects()` | `queries.projects.list()` | `Loaded<readonly Project[]>`: loading, ready(data), failed(error) |
| `useProject(id)` | `queries.projects.byId(id)` | `ProjectView`: loading, ready(project), missing, failed(error) |
| `useProjectPlacements(projectId)` | `queries.placements.byProject(projectId)` | `Loaded<readonly Placement[]>` |

`useProjectCommands()` gives `remove` and `reclone`, which call `server.projects`. `reclone` is Settings → Projects' "Clone at this location": the server clones the recorded remote into the recorded folder (`POST /api/claxedo/projects/:id/reclone`) and refuses while anything is at that path. The Edit dialog saves the name, icon, colour, startup command and environment in one `server.projects.update`; an empty name drops a name set by hand, as v1 did for the folder's own name. These configuration actions are daemon operations; on hosted the adapter refuses them before any HTTP request. The adapter updates the project queries from each answer; this domain never writes the query cache.

The repository picker reads the integrations catalog (`queries.integrations.catalog()`, with `codeHostConnections` picking the code-host connections from it) and `queries.codeHost.repositories(connectionId)`, only where the bootstrap declares Connections (`features.connections`); elsewhere a repository is entered by URL. Failures become `AppError`s through the adapter's `toAppError`.

## Routes

- `/settings/projects`: Settings → Projects (`projectsSettingsSection`), every project; `?project=<id>` shows that project's settings.
- Opening an existing placement (`usePlacementOpener`) opens a draft session pane for it and goes home, as the rail's New session does; the server session starts with the draft's first send.
- `primaryPlacement(placements, projectId)` is the placement a project opens in: its folder, else its first placement. The chip and the first run open a new project's draft there.

`PageEntry.title()` calls `useProjectsText()` and must run under the shell's `I18nProvider`.

## Choosing a folder

v1's folder dialog, on desktop and web alike (`view/select-directory.tsx`, moved from v1's `DialogSelectDirectory`, opened by `pickProjectFolderWith`): "Search folders", "Recent projects" above the folder rows, Tab completes the highlighted row, Enter picks. Its path rules live in `folder-paths.ts` and its search in `folder-search.ts`, both as v1 had them. Server calls go through the adapter: `queries.folders.paths()` and `queries.folders.children(directory)`, `server.folders.search(scope, query, limit)` and `server.folders.browsable()`. A failed call lists no folders, as in v1, and is logged with its folder and query.

## Views

The new-session composer carries v1's context row (`NewSessionContextRow`, built on v1's `SessionContextRow` and its chip pickers). Its Project chip lists the projects in v1's catalog order, by project id, with search; picking one asks the draft's host (`onOpen`) to switch the draft to that project's primary placement. Its footer "Create project…" opens v1's create form (`ProjectCreateForm`): a folder through v1's folder dialog, or a repository by URL or from a connected account, plus the approved optional Name and Account fields. When the server offers a code host that isn't connected, the form shows v1's connect block (`project-create-connect.tsx`): a token, or an OAuth device grant whose approval the adapter waits for, since a grant has no callback (`server.integrations.awaitGrant`, bounded to the code's 15 minutes). A created project opens the same way.

The Environment, Workspace and Branch chips drive the draft's target (`createDraftContext`, owned by the row, one per draft placement; the row attaches it to the screen's `createDraftPlacementResolver`). Environment offers "This computer" when the server runs projects on its own filesystem and "Cloud environment" when cloud workspaces are enabled. Workspace lists "main" (the project's folder) and its worktrees on this machine, or its cloud workspaces; its footer picks "New local worktree" or "New cloud sandbox", made when the draft's first message is sent: the draft screen awaits its resolver's `resolve(draft)` before creating the session, and gets the draft's own placement when nothing else was picked.

The branch chip has two meanings, owned by `draft-branches.ts`. For an existing placement, "Current branch" is disabled and reads that placement's Git status, showing its branch (or detached HEAD) and "Dirty" when staged or unstaged changes exist. It stays disabled when clean, because existing sessions can keep changing that checkout. Only a new workspace enables "Base branch", labeled "From <branch>". Choosing a workspace or environment clears a previous base choice. Existing placements are never checked out or reset by these chips. Status and refs use the shared Git queries and their file-change/turn-completion invalidation.

On first send, a local worktree request carries the selected `baseRef` through the server adapter. The local provisioner resolves that reference to a commit before creating a generated `claxedo/…` branch there, populating its files before returning the placement. A missing or invalid explicit reference fails; it does not substitute HEAD. Omitting the base requests the current commit. Uncommitted source files are not copied, and the source checkout stays untouched. A successful creation selects the returned placement, so a refused session can retry there without creating another worktree. A new cloud sandbox continues to pass the selected branch to cloud creation.

Context row invariants, kept from v1:
- The chips are rebuilt whenever any input moves, so the row keys pickers by position (`Index`); keying by reference would remount an open picker and close it.
- A picker renders its panel once per showing (`untrack`), so a rebuilt chip cannot replace the form and drop what the user typed.
- The row's styles live in `view/context-row.css`, keyed by its own classes and each chip's `data-chip`. Project and environment labels hide when the draft's `session-new-design` container is 30rem or narrower; Workspace and Branch labels remain visible and truncate so the strip stays on one line. The dirty indicator precedes the branch name so it stays visible when a long name truncates. The same sheet sets the picker rows' two-line rhythm and the outlined project avatars.
- `hold(true)` keeps the popover open while the create form has handed focus to the folder dialog; otherwise the outside-dismiss rules unmount the form under the dialog.
- Searchable pickers bind a document keydown (`search-keydown.ts`): arrow keys move the highlighted row while printable keys still edit the search field, whose own value is the query's source of truth.
- The row keeps 4px of itself visible under the composer, which overlaps it by `-mt-2`; the footer actions sit outside `List`'s scroll box so its scroll mask never fades them.

Settings → Projects lists the projects (avatar, name, and the folder or repository they come from). A project's settings show its name, icon, colour, startup script and environment, with v1's Edit dialog (`DialogEditProject`) to change them; where it runs (its placements and the cloud workspaces section); and Remove, which asks first. Dialogs open through the kit's `useDialog()`, so the shell must mount `DialogProvider`.

## Phone

Every control is a kit component or a 44 px row; pages are one column with no horizontal scroll.

## Flows

- Flow 2: local add of a folder and a clone, an edit in Settings → Projects read back by id, remove, a deep link by id.
- Flow 2 worktree branches: existing worktrees show their own branch and dirty status with selection disabled; new worktrees start from the selected branch on first send and preserve the source's uncommitted files. Creation errors retain the selected base; a session refusal retains the created worktree for retry.
- Flow 32: hosted-first add on signed web, the id read back, a deep link by id.
- Flow 1 uses `ProjectCreateForm` as step 1 of `@/onboarding`.

- Flows 24 and 38: a browser signed in to the hosted Worker (the e2e signed stack) opens a stopped sandbox's stored session from the control plane. `src/server/browser-account.test.ts` proves the signed browser lists account projects, placements and sessions without requesting `/api/claxedo/projects`.
