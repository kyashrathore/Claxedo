# Rail

Owns: the main sidebar's composition (`MainSidebar`): the page rows from the shell's `sidebarItems` registry, the session list as the user sees it, and the settings link.

## Concepts

- **Session rows** are a read-only projection of `useSessionStores().list`. The rail never fetches, orders, caches or patches rows; the session list store owns rows, order (`human_turn_desc`) and status. The rail only decides what a row looks like.
- **Rail status** (`model.ts`): one label per row, derived from the store's facts in this order: `pending` (the reader's own create, not yet confirmed), `waiting` (`waitingOnUser`), then the store's status kind (`unknown` when no status fact has arrived, `idle`, `working`, `retrying`, `recovering`, `failed`). Never from timing or message contents.
- **Search** is UI state of the list component: a substring match on the title over the rows already loaded. It never reaches the server.
- **Archive** is one way: the list store never shows archived rows, so an archived session leaves the rail and there is no unarchive in it.
- **Virtualization**: rows render through `@tanstack/solid-virtual`, so 1,000 sessions cost the visible window only.

## Not owned

- Projects and placements belong to `src/projects/` (`useProjects()`); the rail renders what that domain exports.
- New session opens a draft pane (`draftSessionPaneKind` from `src/session/view/`) for the current placement; no session exists on the server until the draft's first send, which creates it through `useSessionStores().list.create` and shows the pending row until the server confirms it. Rename, archive and delete call `useServer().sessions`; their outcome reaches the row through the session list store's events, never by a local patch.

## Flows

Flow 10 (flat order, live status, archive, rename, delete, search) and flow 33 (the drawer on a phone).
