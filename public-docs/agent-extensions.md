# Agent Extensions

Agent Extensions are reusable agent capabilities that can be installed and
materialized for multiple harness targets. The reusable implementation lives in
`@claxedo/agent-extensions`; `@claxedo/workspace-runtime` uses that package for
runtime replay and keeps compatibility re-exports for existing consumers.

Use this package directly when you want extension discovery, install state,
lock files, materialization, or runtime replay without depending on the full
Workspace Runtime package.

## Lifecycle

The product shape is:

```text
discover package -> install desired state -> sync runtime snapshot -> materialize into agent harnesses
```

| Step | What happens in current code |
| --- | --- |
| Discover | The package scans local machine/project installs and resolves GitHub packages. Product/server routes can layer a curated catalog on top. Package discovery identifies supported assets like `SKILL.md`, `mcp.json`, and `.cursor-plugin/plugin.json`. |
| Install | An install stores desired state: extension id, package name, source, enabled flag, scope, targets, and lock data. Targets decide which agent harnesses receive materialized files. |
| Sync | The control plane builds an effective runtime snapshot from project installs, workspace installs, and policy overrides, then pushes it to the connected Workspace Runtime. |
| Materialize | `@claxedo/agent-extensions` replays the snapshot and writes harness-native artifacts for OpenCode, Claude, Codex, and Cursor targets. |
| Activate/deactivate | Local installs can be enabled or disabled. Workspace installs can be enabled or disabled per workspace. Effective policy also supports user, workspace, and org override records before the runtime receives the filtered snapshot. |

## Install The Package

```sh
npm install @claxedo/agent-extensions
```

Use the root export for common lifecycle and policy helpers:

```ts
import {
  createAgentExtensions,
} from "@claxedo/agent-extensions"

const extensions = createAgentExtensions({ projectDir: process.cwd() })

await extensions.install({
  source: "github:acme/review-tools",
  targets: ["codex", "claude"],
})
```

Use subpath exports when you only need replay or materializer APIs:

```ts
import {
  installGitHubAgentExtension,
  getRuntimeAgentExtensionsSnapshot,
  resolveEffectiveAgentExtensionPolicy,
} from "@claxedo/agent-extensions"
import { applyRuntimeAgentExtensions } from "@claxedo/agent-extensions/replay"
import { materializeAgentExtensionSnapshot } from "@claxedo/agent-extensions/materialize"
import { materializeStandaloneMcp } from "@claxedo/agent-extensions/materializers/mcp"
```

## Supported Package Shape

An extension package can contain any of these files:

```text
my-agent-extension/
  SKILL.md
  mcp.json
  .cursor-plugin/plugin.json
```

The runtime materializer supports:

- skills
- standalone MCP configs
- Cursor local plugin packages

One package can include more than one component. For example, a review package
can include a reusable skill plus an MCP server config, and the materializer can
project those components into multiple harnesses from the same install record.

## Targets And Scopes

Supported harness targets:

```ts
["opencode", "claude", "codex", "cursor"]
```

Supported scopes in the materializer:

```ts
type AgentExtensionScope = "project" | "workspace" | "machine"
type MaterializedAgentExtensionScope = "project" | "machine"
```

Workspace scope can be represented in desired state, but materialized runtime
records target project or machine paths.

| Scope | What it means today |
| --- | --- |
| `project` | Local install state lives under the project directory and materializes under project-owned extension state. |
| `machine` | Local install state is machine-level and materializes into machine-level harness locations. |
| `workspace` | Control-plane install state is attached to a workspace id. When synced to a runtime, the runtime materializes the enabled snapshot for that workspace into the project/machine locations it controls. |
| `user` policy | Effective-policy input can enable or disable an extension for a user before the runtime snapshot is produced. |
| `org` policy | Effective-policy input can enable or disable an extension at org policy level. Exposing org-wide activation as product UX is a control-plane concern; the low-level policy shape already exists. |

In public-product terms, the intended composition is:

```text
all users can discover packages
authorized users install packages into workspace desired state
each workspace has its own desired install set
each connected workspace runtime materializes that workspace's effective snapshot
users/admins can activate or deactivate per workspace and per user
org-level defaults can be layered by the control plane
```

The materializer itself does not broadcast to every workspace globally. It
materializes the snapshot it is given. Fan-out across all relevant workspaces is
owned by the product/control plane.

## Across Workspaces

To install a package "everywhere", the product/control plane writes or derives
desired install state for each target workspace, then syncs each connected
runtime. That keeps the runtime simple: every Workspace Host only knows the
project directory it is running next to and the snapshot it was given.

| Product action | Current code path |
| --- | --- |
| Discover packages | Catalog, local scan, project scan, and GitHub package resolution routes in `claxedo-server`. |
| Install for one workspace | Workspace install records store `scope: "workspace"` desired state and lock metadata. |
| Install for many workspaces | Control plane repeats or derives the same desired install state per workspace, then syncs those runtimes. |
| Disable for a workspace | Workspace install `enabled` state or workspace policy override removes it from that runtime snapshot. |
| Disable for a user | User policy override can filter the extension before building the runtime snapshot. |
| Org-level activation/defaults | Policy override shape supports `scope: "org"`; exposing this as org-wide product UX is a control-plane layer. |

## Runtime Replay

`workspace-runtime` calls `applyRuntimeAgentExtensions` from
`@claxedo/agent-extensions` during `host.apply(snapshot)`. A runtime snapshot
can include `agent_extensions`:

```json
{
  "version": 1,
  "harness": { "type": "codex-app-server" },
  "auth": {},
  "mcp": {},
  "workspaceHarnessEnabled": true,
  "agent_extensions": {
    "version": 1,
    "installs": [
      {
        "desired": {
          "id": "review-tools",
          "package_name": "review-tools",
          "enabled": true,
          "scope": "project",
          "targets": ["opencode", "claude", "codex", "cursor"],
          "source": {
            "type": "github",
            "owner": "acme",
            "repo": "agent-extensions",
            "ref": "main",
            "package_path": "packages/review-tools"
          }
        },
        "lock": {
          "resolved_sha": "abc123"
        },
        "components": []
      }
    ]
  }
}
```

The runtime writes desired, lock, and materialized state under
`.agent-extensions/` by default for project scope.

For a workspace install, the server/control-plane path stores `scope:
"workspace"` desired state, computes the effective snapshot, and syncs the
connected runtime for that workspace. The runtime still writes files only inside
the local project or machine locations it owns.

## Activation Policy

Runtime snapshots only include installs whose effective policy is enabled. The
current resolver applies policy in this order:

1. Disabled desired install wins first.
2. Org disable can block the extension.
3. Workspace override wins if present.
4. User override wins next.
5. Org enable applies if present.
6. Otherwise the desired install is enabled.

Example policy override shape:

```json
{
  "id": "review-tools",
  "scope": "workspace",
  "enabled": false,
  "reason": "Disabled for this workspace"
}
```

## Package Exports

`@claxedo/agent-extensions` exports package and materializer helpers including:

- `createAgentExtensions`
- `applyRuntimeAgentExtensions`
- `materializeAgentExtensionSnapshot`
- `installGitHubAgentExtension`
- `installCachedAgentExtension`
- `updateAgentExtension`
- `enableAgentExtension`
- `disableAgentExtension`
- `uninstallAgentExtension`
- `getRuntimeAgentExtensionsSnapshot`
- `resolveEffectiveAgentExtensionPolicy`
- `removeStaleMaterializedComponents`
- `readMaterializedRuntimeRecord`
- `writeMaterializedRuntimeRecord`
- `materializeStandaloneMcp`
- `materializeStandaloneSkill`
- `materializeCursorLocalPlugin`
- `HARNESS_TARGETS`

## Boundaries

The package owns package discovery, source parsing, cache/fetch, desired state,
lock state, workspace install records, effective policy resolution,
materialization, and runtime replay.

Catalog UX, hosted authorization, workspace fan-out, user/org policy UX, and
team-wide defaults are control-plane concerns. The package gives those layers
the primitives they need, but does not decide who is allowed to install an
extension or which workspaces receive a team-wide default.

## Grounding

Implemented in:

- `packages/agent-extensions/src/index.ts`
- `packages/agent-extensions/src/install.ts`
- `packages/agent-extensions/src/replay.ts`
- `packages/agent-extensions/src/materialize.ts`
- `packages/claxedo-server/src/routes/agent-config.ts`
- `packages/workspace-runtime/src/agent-extensions/replay.ts`
- `packages/workspace-runtime/src/index.ts`
