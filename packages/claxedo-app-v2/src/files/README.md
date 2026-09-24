# Files

Owns: the Files panel tab, the `file` pane kind, and the session the panel tools send context to.

## Owned concepts

- **Active session** (`location.ts`): the session the URL names (`/w/:placementId/s/:sessionId`), as a full `SessionRef`. Review comments and browser picks go into that session's composer draft. The placement the panel shows is the shell's `useShellRoute().placementId`; the URL keeps the last session or terminal while a file pane has focus, so the panel stays on its workspace.
- **File tree** (`view/file-tree.tsx`): one directory level per `server.queries.files.tree` query, loaded when the directory is first expanded. Change marks (added, modified, deleted, also rolled up onto parent directories) come from `server.queries.git.status`. Expanded directories and the search text are kept per placement by `FilesProvider` for as long as the scoped shell lives.
- **Search** (`view/files-tab.tsx`): `server.queries.files.search`, while the search field has text; Escape clears it.
- **File pane** (`pane.ts`, `view/file-pane.tsx`): state `{ placementId, path, line?, col? }`, with the path relative to the placement. Text renders in the transcript's `File` viewer, the one code viewer in the app, which highlights, virtualizes and reveals and selects the focus line. Images are previewed, binary files and missing files say so.

## State machines

- **Fetch view** (`model.ts`): every query drawn as `loading`, `ready` or `failed`. A file adds `missing` for a `not_found` answer.

## Invariants

- Trees, contents, search results and status are the adapter's query data, refreshed only by its `filesChanged` invalidation. Nothing here copies them.
- Only `src/server/` turns a placement into a directory; paths here are always relative to the placement.
- A focus line is re-applied for 5 s after the pane mounts, because the viewer's rebuilds can reset the scroll position right after the first reveal.

## Flows

Flow 11 (a file link opens the file tab), flow 13 (a terminal link opens the file at the line) and flow 33 (phone).
