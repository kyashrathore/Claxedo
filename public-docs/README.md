# Claxedo Packages

> ℹ️ **This directory is in-repo engineering reference, not a website source.**
> It exists for release, deployment, and package-maintenance workflows. What
> reads this directory:
>
> - `deploy-relay.yml` cites [`relay-and-deployment.md`](./relay-and-deployment.md)
>   by path in its policy and rollback instructions.
> - The marketing site (`packages/claxedo-web/src/content/site.ts`) links
>   [`user-deployed-cloudflare.md`](./user-deployed-cloudflare.md) as its
>   Cloudflare deploy guide.
> - `packages/workspace-runtime/scripts/verify-publish.ts` gates publishing on the
>   "Mounted Route Families" table in [`workspace-runtime.md`](./workspace-runtime.md)
>   matching `docs/api-manifest.json`.
>
> Keep these pages accurate for those consumers. They are not published as a
> standalone documentation product.

Claxedo is a set of composable packages for building coding-agent products.
The packages in this repo let you normalize agent events, drive multiple agent
harnesses through one runtime facade, run a per-workspace host, attach that host
through a relay, and expose runtime tools over MCP. The Claxedo product can
optionally compose its server-owned Agent Plugins feature around these packages.

Use these packages when you want to:

- talk to configured connections, native SDK harnesses, and Pi through one
  session/runtime surface
- build infrastructure for terminal coding agents: sessions, PTYs, processes,
  files, diffs, events, and harness config
- let users enable standard Agent Plugins for selected harnesses through the
  optional Claxedo product module
- host a team app on your own system, backed by local worktrees, containers, or
  cloud VMs
- let authorized teammates reach a workspace on one of your machines through Relay
- drive a running Claxedo from any MCP client through its `/api/claxedo/mcp` endpoint

The practical shape is:

```text
your product
   |
   v
@claxedo/workspace-relay
@claxedo/workspace-relay-protocol
@claxedo/workspace-runtime
@claxedo/agent-runtime-contract
```

Each layer can be used independently. Full workspace products usually start
with `@claxedo/workspace-runtime`, because it creates the host that owns harness
lifecycle, sessions, terminals, managed processes, files, diff routes, and
runtime events for one workspace. Agent Plugins catalog, activation, retained
artifacts, and projection are product features, not public runtime-package APIs.

## Packages

| Package | Use it for |
| --- | --- |
| `@claxedo/workspace-runtime` | Run or embed a per-workspace host next to the project directory the agent should work on. |
| `@claxedo/agent-runtime-contract` | Type and validate the sessions, messages, runtime events and presentation events every runtime package and client shares. |
| `@claxedo/workspace-relay-protocol` | Use tunnel wire types and token verifier contracts without pulling in Hono or server code. |
| `@claxedo/workspace-relay` | Run the relay process that connects browsers/gateways to workspace-runtime hosts. |

## Start Here

- [Workspace Runtime](./workspace-runtime.md): what the Workspace Host is,
  what it owns, how to run it, and how to embed it.
- [Agent Runtime Contract](../packages/agent-runtime-contract/README.md): the
  session, message, runtime-event and presentation-event types every runtime
  package and client shares.
- [Machines, Workspaces and Sessions](./machines-and-sessions.md): working with
  your own machines, cloud environments and the sessions that run on them.
- [Using an ACP Agent](./using-agent-connections.md): add an external agent
  such as Cursor over ACP, choose when it runs, what a turn carries, what it
  cannot do, and what each error means.
- [Agent Connections](./acp-connections.md): configure provider-owned agent
  runtimes without exposing trusted descriptors or secrets to the browser.
- [Relay And Deployment](./relay-and-deployment.md): local, private VM,
  config-token, and relay-attached runtime shapes.
- [Sandbox Egress Containment](./sandbox-egress.md): which drivers can contain a
  sandbox's outbound network, which production configurations run unrestricted,
  and how to get enforcement.
- [Self-Host on Fly.io](./self-host-fly.md): the `claxedo deploy` wizard —
  an unsigned single-user control plane on your own Fly account.
- [User-deployed Cloudflare](./user-deployed-cloudflare.md): deploy Claxedo to your own Cloudflare account with
  one command, claim it as owner, upgrade by re-running it.
- [Writing An Auth Or Storage Port](./writing-an-auth-or-storage-port.md): where a
  third-party identity provider or database plugs in — the injected ports, the
  conformance suites that prove an implementation, and the static entrypoint
  that selects it.
- [MCP](./mcp.md): the `/api/claxedo/mcp` endpoint, its tools, and how to connect.
