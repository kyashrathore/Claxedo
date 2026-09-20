# Provisioned and Relayed Workspace Startup

The hosted implementation of `platform/runtime/workspace-startup-port.ts`:
waking a provisioned sandbox, connecting to another machine through the Relay,
and admitting a session worktree on that machine. Every operation here needs
the account-bearing transport, so none of them exist in a local build.

Nothing outside this directory imports it except `app/entry/main.tsx`, which
binds `cloudWorkspaceStartup` for the hosted build (`app/entry/local.tsx`
deliberately binds nothing), and `features/workspaces/data/workspace-connection.ts`,
which is hosted so it imports the implementation directly. Local callers name
the operation through `workspaceStartup()`.

Reading the workspace runtime RECORD is NOT here — see
`platform/runtime/workspace-runtime-record.ts`. Distinct from `agent/` (general
session routing).

```json
{
  "owns": "Workspace startup on a provisioner or another machine (WorkspaceStartupPort implementation)",
  "writerOf": [],
  "mustNotImport": ["@/ui/*", "@opencode-ai/ui/*", "@/features/agent-plugins/*"]
}
```
