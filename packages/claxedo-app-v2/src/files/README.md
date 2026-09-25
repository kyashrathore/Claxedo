# Files

Owns: the Files navigator and the file tab the workspace panel shows, and the session the panel tools send context to.

## Owned concepts

- **Active session** (`location.ts`): the session the URL names (`/w/:placementId/session/:sessionId`), as a full `SessionRef`. Review comments and browser picks go into that session's composer draft. The placement the panel shows is the shell's `useShellRoute().placementId`.
- **Files navigator** (`view/files-navigator.tsx`): v1's search row over v1's tree. The file open in the panel is expanded to, scrolled into view and highlighted.
- **Search view** (`search-view.ts`, `search-query.ts`, `search-tree.ts`): the query is the field's text 150 ms after the last keystroke (at once when it is emptied or the placement changes). `server.queries.files.search` (files only, as v1) answers it; the tree then shows only the matches and their folders, built from the result's own paths, so no folder is listed while searching. As in v1, every folder of a result is expanded in `FilesProvider` and stays expanded after the search is cleared; the listings of those folders are read once the field is empty. A result with the same paths as the one shown, in any order, changes nothing. Escape or "Clear search" clears it, and the tree stays mounted meanwhile.
- **Tree** (`view/file-tree.tsx`, `view/file-tree-node.tsx`, `tree-source.ts`, `tree-helpers.ts`): one `server.queries.files.tree` query per expanded directory, sorted folders first. Rows are 24 px: a chevron for folders, a grey file icon that takes its color on hover, the name, and the change mark from `server.queries.git.status` (A/D/M for files, a dot for folders). Each level shows 24 entries around the active file with "Show 24 more" on either side, and draws indent guides while hovered. Expanded folders and the search text are kept per placement by `FilesProvider`. A level that fails to load says "The files could not be loaded" with Retry.
- **File tab** (`view/file-tab.tsx`): v1's panel file viewer for `{ placementId, path }`, with the path relative to the placement. Text renders in the transcript's `File` viewer, which highlights, virtualizes, reveals and selects the focus line. Markdown renders by default; "Show source" flips it per path, kept per placement by `FilesProvider`. Images are previewed, binary files say so, a read failure shows its message. "Copy relative path" portals into the panel's L2 row.

## Invariants

- Trees, contents, search results and status are the adapter's query data, refreshed only by its `filesChanged` invalidation. Nothing here copies them.
- Only `src/server/` turns a placement into a directory; paths here are always relative to the placement.
- A focus line is re-applied for 5 s after the focus request, because the viewer's rebuilds can reset the scroll position right after the first reveal.

## Flows

Flow 11 (a file link opens the file tab), flow 13 (a terminal link opens the file at the line) and flow 33 (phone).
