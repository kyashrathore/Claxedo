# Cloud Workspace Startup

The hosted implementation of `platform/runtime/workspace-startup-port.ts`:
waking a central cloud sandbox, connecting a user-hosted host through the Relay,
and admitting a session worktree on that host. Every operation here needs the
account-bearing transport, so none of them exist in a local build.

Nothing outside this directory imports it except `app/entry/main.tsx`, which
binds `cloudWorkspaceStartup` for the hosted build (`app/entry/local.tsx`
deliberately binds nothing) and the hosted connection authority
`features/workspaces/data/workspace-connection.ts`, which moves with it. Local
callers name the operation through `workspaceStartup()`.

Reading the workspace runtime RECORD is NOT here — see
`platform/runtime/workspace-runtime-record.ts`. Distinct from `agent/` (general
session routing) and from `context/` providers.

```json
{
  "owns": "Hosted cloud/user-hosted workspace startup (WorkspaceStartupPort implementation)",
  "writerOf": [],
  "mustNotImport": [
    "@/claxedo-ui/*",
    "@claxedo/claxedo-ui/*",
    "../claxedo-ui/*",
    "@/pages/*",
    "../pages/*",
    "@opencode-ai/ui/*",
    "@/features/extensions/marketplace/*",
    "../marketplace/*"
  ]
}
```
