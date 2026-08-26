# Agent Runtime Layer

Headless session-transport client for the agent runtime: the placement table
(`placement-table.ts`) that decides which transport a session read/write uses,
the HTTP client that executes it (`agent-runtime-client.ts`), signed-workspace
resolution (`signed-workspace.ts`), the single `WorkspaceKind` union
(`workspace-kind.ts`), and session projection. No UI, no Solid runtime — this
layer shapes requests/responses and owns routing decisions only.

```json
{
  "owns": "Session-routing placement table, agent-runtime HTTP client, signed-workspace resolution, WorkspaceKind",
  "writerOf": [],
  "mustNotImport": [
    "@opencode-ai/ui/*",
    "@/components/*",
    "../components/*",
    "@/claxedo-ui/*",
    "@claxedo/claxedo-ui/*",
    "../claxedo-ui/*",
    "@/pages/*",
    "../pages/*"
  ]
}
```
