# Projects

Owns: the project record as the app sees it, its placements, the add-project flow, rename and remove, and the routes that name a project or a placement by id.

## Concepts

- **Project**: a server record with an id (`Project` from `@/server`). The list comes from the server through `server.queries.projects.list()`; nothing is read from browser storage.
- **Placement**: where a project runs, a folder, a worktree or a cloud workspace (`Placement`). A placement has its own id; a session belongs to one placement. A folder path is display data, never a key, a route parameter or an identity. Only `src/server/` turns a placement into a directory.
- **Source**: what the project is made from, a repository URL, a repository from a connected code host, or a folder on a machine. A folder is offered only when the server reports `thisMachine`.
- **Draft** (`ProjectDraft`): the answers the add flow collects (name, source, harness, placement choice) before anything is created.

## Data

`store.ts` reads through the adapter's query options and exposes machines, never raw queries:

| Hook | Home | State |
| --- | --- | --- |
| `useProjects()` | `queries.projects.list()` | `Loaded<readonly Project[]>`: loading, ready(data), failed(error) |
| `useProject(id)` | `queries.projects.byId(id)` | `ProjectView`: loading, ready(project), missing, failed(error) |
| `useProjectPlacements(projectId)` | `queries.placements.byProject(projectId)` | `Loaded<readonly Placement[]>` |
| `useMachines()` | `queries.machines.list()` | `Loaded<readonly Machine[]>` |

`useProjectCommands()` gives `rename` and `remove`, which call `server.projects`. Events invalidate the queries through the adapter's event table; this domain never writes the query cache.

`api.ts` types the query options this domain needs that the adapter has not landed yet (`queries.projects`, `queries.machines`, `queries.codeHost`) as a cast over `Server`; the cast goes when the adapter exports them.

## State machines

**Add project** (`model.ts`): `choosingSource → choosingAgent → choosingPlacement → creating → created(projectId, placementId?)`, with `failed(error)` from `creating`. Events: `sourceChosen`, `agentChosen`, `back`, `createRequested`, `projectRecorded`, `projectCreated`, `createFailed`.

The flow is hosted first: name and source, then the AI, then where it runs. On every deployment the record is created first through the projects route, then its placement: a cloud workspace through `@/cloud`, or the placement the server registered for the chosen machine. The panels of visited steps stay mounted and hidden, so Back keeps what the user entered.

Once the record exists, `choosingPlacement`, `creating` and `failed` carry its `projectId`. Retrying places that project again and never posts a second record, and Back stops at the placement step (`canGoBack`), because the name and source now belong to a server record.

## Routes

- `/p/:projectId`: the project page (`projectPage`).
- `/projects/new`: the add-project page (`addProjectPage`).
- Opening a placement (`usePlacementOpener`) creates a session in it, with the chosen harness after an add, and goes to `/w/:placementId/s/:sessionId`, as the rail's New session does. A created project with no placement opens its project page. A failed session create is shown as a toast.

`PageEntry.title()` calls `useProjectsText()` and must run under the shell's `I18nProvider`.

## Views

`ProjectsSidebarSection` lists projects for the rail with a per-row menu (rename, remove). `ProjectPage` shows the record, its local placements and the cloud workspaces section. Dialogs open through the kit's `useDialog()`, so the shell must mount `DialogProvider`.

## Phone

Every control is a kit component or a 44 px row; pages are one column with no horizontal scroll.

## Flows

- Flow 2: local add of a folder and a clone, rename, remove, a deep link by id.
- Flow 32: hosted-first add on signed web, the id read back, a deep link by id.
- Flow 1 uses the same steps inside `@/onboarding`.
