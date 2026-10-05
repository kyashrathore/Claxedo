# @claxedo/mcp

The first-party Claxedo MCP: one streamable-HTTP endpoint, `/api/claxedo/mcp`,
served by whichever Claxedo process is already running, and installed in a
harness the way any remote MCP is installed — by URL. There is no stdio
binary and no npm package; this is a private workspace package consumed as
source by the three processes that mount it.

## What is here

| Path | Owns |
| --- | --- |
| `src/server.ts` | `createClaxedoMcpRoutes(options)`: the Hono route, credential resolution, loopback hardening, the bounded session store, the per-credential in-flight cap, and the mount option types every composition uses (`FirstPartyMcpOptions`, `McpClientInputs`). |
| `src/endpoint/` | The pieces the route is built from: the loopback socket/host/origin gate, the session store, the in-flight counter. |
| `src/context.ts` | `McpCredential` (runtime or user), tool access declarations, the audit event, and the handler-side access check. |
| `src/tools/registry.ts` | `createToolRegistry(server, ctx)`: one `McpServer` per connection, built for one credential; a tool the credential may not use is never registered, and the handler re-checks anyway. |
| `src/tools/target.ts`, `src/tools/session-reach.ts` | Where a call may act: the workspace a runtime credential may write to, and the session it may drive — itself and the children it started, read from the runtime's stored rows rather than from the call. |
| `src/client/` | `ClaxedoMcpClient`, the one client every tool calls; no tool builds a URL. |
| `src/tools/app-plugins.ts`, `app-plugins-guide.ts` | App plugin authoring (`app_plugin_create`, `app_plugin_check`, `app_plugin_add`, `app_plugin_guide`) and the authoring guide, the one copy every harness reads. |

## The three mounts

| Process | Composition option | Admits | Serves in-process |
| --- | --- | --- | --- |
| Desktop / local server (`@claxedo/local-server`, `createLocalApp`) | `firstPartyMcp: LoopbackFirstPartyMcpOptions` | the runtime credential only | this machine's runtimes, through the local app's own fetch bound to the credential's workspace |
| Cloud VM runtime (`@claxedo/workspace-runtime`, `createWorkspaceRuntimeApp`) | `firstPartyMcp: LoopbackFirstPartyMcpOptions` | the runtime credential only | that workspace's runtime; under relay exposure the tools' in-process calls carry a token only the process knows, which relay-host auth accepts as direct |
| Hosted worker (`@claxedo/server`, `createHostedCoreApp`) | `firstPartyMcp: FirstPartyMcpOptions` | the CLI JWT as the whole account; the per-turn bearer of a session served by its own host | nothing in-process; the control plane as the caller, or for a session-host session its own host for that session's own routes and its workspace machine for the rest, both through the relay |

Every mount is absent until its composition supplies the option; the route is
a contribution like the others, mounted under its own owner.

## Credentials by situation

- A session Claxedo launched, on the laptop or in a cloud VM, reaches the
  loopback URL of the runtime that launched it with the bearer that runtime
  minted and `?session=<id>` naming the parent session. The loopback mounts
  accept nothing else, reject a non-loopback socket peer, `Host`, or
  `Origin` with 403, reflect no CORS origin, and never read a credential
  from the URL.
- A Pi session served by its own Durable Object reaches the hosted URL with
  the bearer its turn's delivery carried (`?session=<id>`): only on a turn the
  owner drives in their own session, never a member's, bound to owner, session and workspace, expiring with the turn
  and at most ten minutes, under an audience only this endpoint verifies, and
  refused once the session is deleted. It is a runtime credential with no
  control plane: its tools act on that workspace's machine and nowhere else.
- A person's own tools — Claude Code, Codex, Cursor, a phone — reach the
  hosted URL. The CLI JWT is the whole account: every scope, nothing
  read-only. A client with no credential is answered 401 with a
  `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"`
  challenge, which is what an MCP OAuth client follows.

The credential decides which tools `tools/list` returns: a runtime credential
sees the `runtime` audience, a user credential the `user` audience, and a
read-only credential sees no write. A tool outside the audience is not
registered, so calling it anyway is answered by the SDK as an unknown tool.

`session_delete` is the one destructive tool a session is offered. It is in
the `sessions` group, which is on by default for every project. Inside a
session it exists only while the composition answers that only the
workspace's owner has driven that session and its ancestors: the desktop
reads the session's prompt actors, a cloud runtime compares them with its
owner grant's actor, and a composition with no answer offers no
`session_delete` at all. It reaches only the sessions of the workspace the
caller runs in, whatever the account allows on other machines, and runs only
once the person accepts a confirmation that names the session and how many
sessions sit under it. The runtime removes the session and
every session under it leaf-first, and refuses the whole tree while any of
them is working, waiting for input or held by another operation; a
provider's subagent session is removed only with its parent.

## App plugins

The `app-plugins` group lets a session make an app plugin for the Claxedo app on the machine it runs on. Its tools exist only when the client carries an `AppPluginsGrant`, and a composition hands one only to a session of the machine's owner, bound to that session's workspace folder: the desktop's local server, for a session no relayed turn has reached (its own or an ancestor's). A cloud runtime and the hosted worker serve none. The grant is the daemon's (`packages/claxedo-local-server/src/plugins/authoring.ts`): it scaffolds, checks with `@claxedo/plugin-build`, and registers through the same live-plugin service the `/api/claxedo/live-plugins` route uses.

The guide is served by the tools themselves rather than as a skill, because the MCP server is the one channel every harness that can act on it shares: `app_plugin_create` returns it with the new folder and `app_plugin_guide` returns it on demand. MCP prompts reach a model only when a person invokes them, and not every harness reads resources or server instructions.

A model can be talked into making a plugin by text it reads: a file, a page, a tool result. The guide tells it to act only on the person's request, but the gate is the app: a newly added plugin, or one whose manifest asks for more access, runs only after the person turns it on in a dialog that lists what it may reach.

## Sessions, elicitation, limits

Sessions are stateful (`Mcp-Session-Id`) because a host's elicitation answer
arrives on a later request and must reach the server that asked. Each
process holds at most 256 sessions, drops one idle for 30 minutes, binds each
to the credential that initialized it, and answers 404 for a session it no
longer holds — the transport's signal to initialize again. On the hosted
worker that state is per isolate, so a user credential's session lives only
as long as its requests keep reaching that isolate. A runtime credential there
is a session host's bearer, minted again with every turn, so each of its
requests is answered on its own, as JSON, with no `Mcp-Session-Id`, no GET
stream (405) and no elicitation. A destructive tool's confirmation rides the
SSE stream of the tool call that asked whenever that is the only call open.
Destructive tools require an accepted elicitation result. Clients without
elicitation support receive a refusal; tool annotations do not grant approval.

One credential may hold at most 8 requests open at once (`maxInFlightPerCredential`);
the ninth is answered 429 with `Retry-After: 1`. Every write goes through the
`audit` sink the mount wires: the control plane's authority audit on hosted
and node, the process log on loopback.

## Verify

```sh
bun run typecheck
bun run test
```

The endpoint test drives a real MCP `Client` over `StreamableHTTPClientTransport`
against the route served on `127.0.0.1:0`.
