# Agent Plugins Feature

The standard plugin catalog client, the Directory that browses it, and the
install flow form one vertical feature. Product composition owns whether this
feature is present in a build.

- `api.ts` — the catalog transport and its response contracts (both rails).
- `connections.ts` — the MCP connection port the Directory and the install sheet
  both drive; `app/composition/agent-plugin-connections.ts` implements it.
- `directory/` — the browse surface: sections, source chips, search, and the
  detail pane. `directory/data.ts` owns the sources and machine-installed reads
  that live beside the catalog; `directory/view.ts` holds the pure derivations
  (section membership, category chips, status lines, search) the surface and its
  tests share. Every destructive action confirms through `requestConfirm` from
  `@/ui/dialogs/confirm`.
- `install/` — the install sheet the Directory opens on `Add`.
- `mcp/` — `catalog-dialog.tsx`, the MCP half of the same catalog in a dialog:
  the composer's `/mcp` surface, composed by `app/dialogs/select-mcp.tsx`.
