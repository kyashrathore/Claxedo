# Projects

Owns: the project as the app sees it, its placements, the add-project flow, Settings → Projects (v1's Edit dialog and remove), v1's project list data for the rail, and the routes that name a project or a placement by id.

## Concepts

- **Project** (`Project` from `@/server`): one entry of `/api/claxedo/projects`, the only project source. The route lists every project v1 lists, with v1's name, icon, colour and startup command, its environment, its source, its checkout `directory` (display only) and `available`, false when none of its placements can be reached. Removing a project removes it and its placements everywhere.
- **Rail list** (`createProjectList`, `ProjectListProvider`): v1's sidebar data, the route's projects in this browser's order with their expanded flags and colours, persisted per server as v1 did (`project-state.ts`, keyed by project id). New projects join at the end in v1's catalog order, by project id (`project-order.ts`), which is also a fresh browser's whole order. A project without a colour gets a free one (`project-colors.ts`), saved through the route.
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
| `useMachines()` | `queries.machines.list()` | `Loaded<readonly Machine[]>` |

`useProjectCommands()` gives `remove`, which calls `server.projects`. The Edit dialog saves the name, icon, colour, startup command and environment in one `server.projects.update`; an empty name drops a name set by hand, as v1 did for the folder's own name. The adapter updates the project queries from each answer; this domain never writes the query cache.

The repository picker reads `queries.codeHost.connections()` and `queries.codeHost.repositories(connectionId)`. Failures become `AppError`s through the adapter's `toAppError`.

## State machines

**Add project** (`model.ts`): `choosingSource → choosingAgent → choosingPlacement → creating → created(projectId, placementId?)`, with `failed(error)` from `creating`. Events: `sourceChosen`, `agentChosen`, `back`, `createRequested`, `projectRecorded`, `projectCreated`, `createFailed`.

The flow is hosted first: name and source, then the AI, then where it runs. On every deployment the record is created first through the projects route, then its placement: a cloud workspace through `@/cloud`, or the placement the server registered for the chosen machine. The panels of visited steps stay mounted and hidden, so Back keeps what the user entered.

Once the record exists, `choosingPlacement`, `creating` and `failed` carry its `projectId`. Retrying places that project again and never posts a second record, and Back stops at the placement step (`canGoBack`), because the name and source now belong to a server record.

## Routes

- `/settings/projects`: Settings → Projects (`projectsSettingsSection`), every project; `?project=<id>` shows that project's settings.
- Opening an existing placement (`usePlacementOpener`) opens a draft session pane for it and goes home, as the rail's New session does; the server session starts with the draft's first send.
- A created project (`useCreatedProjectOpener`) starts its first session in the new placement with the harness chosen in the AI step, and goes to `/w/:placementId/s/:sessionId`. The onboarding screen renders outside the workbench, and the session is what carries that harness. A created project with no placement opens its settings; a failed session create is shown as a toast.

`PageEntry.title()` calls `useProjectsText()` and must run under the shell's `I18nProvider`.

## Choosing a folder

v1's folder dialog, on desktop and web alike (`view/select-directory.tsx`, moved from v1's `DialogSelectDirectory`, opened by `pickProjectFolderWith`): "Search folders", "Recent projects" above the folder rows, Tab completes the highlighted row, Enter picks. Its path rules live in `folder-paths.ts` and its search in `folder-search.ts`, both as v1 had them. Server calls go through the adapter: `queries.folders.paths()` and `queries.folders.children(directory)`, `server.folders.search(scope, query, limit)` and `server.folders.browsable()`. A failed call lists no folders, as in v1, and is logged with its folder and query.

## Views

The new-session composer carries v1's context row (`NewSessionContextRow`, built on v1's `SessionContextRow` and its chip pickers). Its Project chip lists the projects, most recently updated first, with search; picking one asks the draft's host (`onOpen`) to switch the draft to that project's primary placement. Its footer "Create project…" opens v1's create form (`ProjectCreateForm`): a folder through v1's folder dialog, or a repository by URL or from a connected account, plus the approved optional Name and Account fields. A created project opens the same way.

Context row invariants, kept from v1:
- The chips are rebuilt whenever any input moves, so the row keys pickers by position (`Index`); keying by reference would remount an open picker and close it.
- A picker renders its panel once per showing (`untrack`), so a rebuilt chip cannot replace the form and drop what the user typed.
- `hold(true)` keeps the popover open while the create form has handed focus to the folder dialog; otherwise the outside-dismiss rules unmount the form under the dialog.
- Searchable pickers bind a document keydown (`search-keydown.ts`): arrow keys move the highlighted row while printable keys still edit the search field, whose own value is the query's source of truth.
- The row keeps 4px of itself visible under the composer, which overlaps it by `-mt-2`; the footer actions sit outside `List`'s scroll box so its scroll mask never fades them.

Settings → Projects lists the projects (avatar, name, and the folder or repository they come from). A project's settings show its name, icon, colour, startup script and environment, with v1's Edit dialog (`DialogEditProject`, also exported for the rail's project menu) to change them; where it runs (its placements and the cloud workspaces section); and Remove, which asks first. Dialogs open through the kit's `useDialog()`, so the shell must mount `DialogProvider`.

## Phone

Every control is a kit component or a 44 px row; pages are one column with no horizontal scroll.

## Flows

- Flow 2: local add of a folder and a clone, an edit in Settings → Projects read back by id, remove, a deep link by id.
- Flow 32: hosted-first add on signed web, the id read back, a deep link by id.
- Flow 1 uses the same steps inside `@/onboarding`.
