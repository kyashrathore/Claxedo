# Claxedo Packages

> ℹ️ **This directory is in-repo engineering reference, not a website source.**
> It exists for release, deployment, and package-maintenance workflows. What
> reads this directory:
>
> - `deploy-control-plane.yml`, `deploy-convex.yml`, and `deploy-relay.yml` cite
>   [`deploy-runbook.md`](./deploy-runbook.md) and
>   [`relay-and-deployment.md`](./relay-and-deployment.md) by path in their
>   rollback instructions.
> - `packages/workspace-runtime/scripts/verify-publish.ts` gates publishing on the
>   "Mounted Route Families" table in [`workspace-runtime.md`](./workspace-runtime.md)
>   matching `docs/api-manifest.json`.
>
> Keep these pages accurate for those consumers. They are not published as a
> standalone documentation product.

Claxedo is a set of composable packages for building coding-agent products.
The packages in this repo let you normalize agent events, drive multiple agent
harnesses through one runtime facade, run a per-workspace host, attach that host
through a relay, expose runtime tools over MCP, and materialize reusable Agent
Extensions.

Use these packages when you want to:

- talk to OpenCode, ACP harnesses, native SDK harnesses, and Pi through one
  session/runtime surface
- build infrastructure for terminal coding agents: sessions, PTYs, processes,
  files, diffs, events, and harness config
- let users discover a skill/MCP/plugin package, install it into workspace
  desired state, activate/deactivate it, and materialize it for multiple harness
  targets
- host a team app on your own system, backed by local worktrees, containers, or
  cloud VMs
- let authorized teammates reach a user-hosted local workspace through Relay
- add MCP tools that orchestrate the runtime/server API stack

The practical shape is:

```text
your product
   |
   v
@claxedo/mcp
@claxedo/workspace-relay
@claxedo/workspace-relay-protocol
@claxedo/workspace-runtime
@claxedo/agent-extensions
@claxedo/agent-sdk-runtime
@claxedo/agent-event-runtime
```

Each layer can be used independently. Full workspace products usually start
with `@claxedo/workspace-runtime`, because it creates the host that owns harness
lifecycle, sessions, terminals, managed processes, files, diff routes, runtime
events, and Agent Extension replay for one workspace. Products that only need
extension package discovery, install state, lock state, policy, or
materialization can use `@claxedo/agent-extensions` directly.

## Packages

| Package | Use it for |
| --- | --- |
| `@claxedo/workspace-runtime` | Run or embed a per-workspace host next to the project directory the agent should work on. |
| `@claxedo/agent-extensions` | Discover, install, lock, materialize, and replay reusable Agent Extension packages for OpenCode, Claude, Codex, and Cursor. |
| `@claxedo/agent-sdk-runtime` | Embed one `AgentRuntime` facade over OpenCode, ACP harnesses, native SDK harnesses, or Pi. |
| `@claxedo/agent-event-runtime` | Normalize raw harness events into a canonical `AgentRuntimeEvent` stream and project them into compatibility formats. |
| `@claxedo/workspace-relay-protocol` | Use tunnel wire types and token verifier contracts without pulling in Hono or server code. |
| `@claxedo/workspace-relay` | Run the relay process that connects browsers/gateways to workspace-runtime hosts. |
| `@claxedo/mcp` | Expose Claxedo runtime tools to any MCP client. |

Agent Extensions are available as `@claxedo/agent-extensions`. The replay and
materializer helpers live only in `@claxedo/agent-extensions`;
`workspace-runtime` re-exports only the extension-scope types
(`AgentExtensionScope`, `HarnessTarget`, `MaterializedAgentExtensionScope`,
`PackageSource`) from its `/config` subpath, and new consumers should import
`@claxedo/agent-extensions` directly for the helpers.

## Start Here

- [See It All In Action](./see-it-all-in-action.md): how the packages compose
  into a full coding-agent app.
- [Workspace Runtime](./workspace-runtime.md): what the Workspace Host is,
  what it owns, how to run it, and how to embed it.
- [Agent SDK Runtime](./agent-sdk-runtime.md): the `createAgentRuntime()`
  facade, first-party stores, and supported harness factories.
- [Agent Event Runtime](./agent-event-runtime.md): event normalization and
  projections.
- [Operator-Configured ACP Connections](./acp-connections.md): plug any
  stdio ACP agent into a Claxedo server as a first-class harness.
- [Agent Extensions](./agent-extensions.md): discover, install, activate, sync,
  and materialize extension packages across harness targets.
- [Relay And Deployment](./relay-and-deployment.md): local, private VM,
  config-token, and relay-attached runtime shapes.
- [Sandbox Egress Containment](./sandbox-egress.md): which drivers can contain a
  sandbox's outbound network, which production configurations run unrestricted,
  and how to get enforcement.
- [Self-Host on Fly.io](./self-host-fly.md): the `claxedo deploy` wizard —
  a zero-Convex/Clerk unsigned single-user control plane on your own Fly account.
- [MCP](./mcp.md): current MCP server tools and environment variables.
- [Supported Surfaces](./supported-surfaces.md): source-grounded status table.
