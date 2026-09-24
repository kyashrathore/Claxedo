# Files

Owns: the Files navigator and the file tab the workspace panel shows, and the session the panel tools send context to.

## Owned concepts

- **Active session** (`location.ts`): the session the URL names (`/w/:placementId/s/:sessionId`), as a full `SessionRef`. Review comments and browser picks go into that session's composer draft. The placement the panel shows is the shell's `useShellRoute().placementId`.
- **File tree** (`view/file-tree.tsx`): one directory level per `server.queries.files.tree` query, loaded when the directory is first expanded. Change marks (added, modified, deleted, also rolled up onto parent directories) come from `server.queries.git.status`. Expanded directories and the search text are kept per placement by `FilesProvider` for as long as the scoped shell lives.
- **Navigator** (`view/files-navigator.tsx`): the search field over the tree; `server.queries.files.search` while the field has text, Escape clears it. A file row or result calls the panel's `onOpenFile`.
- **File tab** (`view/file-tab.tsx`): v1's panel file viewer for `{ placementId, path }`, with the path relative to the placement. Text renders in the transcript's `File` viewer, which highlights, virtualizes, reveals and selects the focus line. Markdown renders by default; "Show source" flips it per path for the session (`markdown-view.ts`). Images are previewed, binary files say so, a read failure shows its message. "Copy relative path" portals into the panel's L2 row.

## State machines

- **Fetch view** (`model.ts`): every query drawn as `loading`, `ready` or `failed`.

## Invariants

- Trees, contents, search results and status are the adapter's query data, refreshed only by its `filesChanged` invalidation. Nothing here copies them.
- Only `src/server/` turns a placement into a directory; paths here are always relative to the placement.
- A focus line is re-applied for 5 s after the focus request, because the viewer's rebuilds can reset the scroll position right after the first reveal.

## Flows

Flow 11 (a file link opens the file tab), flow 13 (a terminal link opens the file at the line) and flow 33 (phone).
