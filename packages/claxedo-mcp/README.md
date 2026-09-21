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

## The three mounts

| Process | Composition option | Admits | Serves in-process |
| --- | --- | --- | --- |
| Desktop / local server (`@claxedo/local-server`, `createLocalApp`) | `firstPartyMcp: LoopbackFirstPartyMcpOptions` | the runtime credential only | this machine's runtimes, through the local app's own fetch bound to the credential's workspace |
| Cloud VM runtime (`@claxedo/workspace-runtime`, `createWorkspaceRuntimeApp`) | `firstPartyMcp: LoopbackFirstPartyMcpOptions` | the runtime credential only | that workspace's runtime; under relay exposure the tools' in-process calls carry a token only the process knows, which relay-host auth accepts as direct |
| Hosted worker (`@claxedo/server`, `createHostedCoreApp`) | `firstPartyMcp: FirstPartyMcpOptions` | the CLI JWT as the whole account; a runtime credential when the entry supplies `verifyRuntimeCredential` | nothing; the control plane, as the caller |
| Self-hosted node (`@claxedo/server`, `createSelfHostedApp`) | `firstPartyMcp: FirstPartyMcpOptions` | as hosted, plus the unsigned loopback caller as the box's anonymous account | the node's own runtimes behind its runtime proxy, and the control plane |

Every mount is absent until its composition supplies the option; the route is
a contribution like the others, mounted under its own owner.

## Credentials by situation

- A session Claxedo launched, on the laptop or in a cloud VM, reaches the
  loopback URL of the runtime that launched it with the bearer that runtime
  minted and `?session=<id>` naming the parent session. The loopback mounts
  accept nothing else, reject a non-loopback socket peer, `Host`, or
  `Origin` with 403, reflect no CORS origin, and never read a credential
  from the URL.
- A person's own tools — Claude Code, Codex, Cursor, a phone — reach the
  hosted URL. The CLI JWT is the whole account: every scope, nothing
  read-only. A client with no credential is answered 401 with a
  `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"`
  challenge, which is what an MCP OAuth client follows.

The credential decides which tools `tools/list` returns: a runtime credential
sees the `runtime` audience, a user credential the `user` audience, and a
read-only credential sees no write. A tool outside the audience is not
registered, so calling it anyway is answered by the SDK as an unknown tool.

## Sessions, elicitation, limits

Sessions are stateful (`Mcp-Session-Id`) because a host's elicitation answer
arrives on a later request and must reach the server that asked. Each
process holds at most 256 sessions, drops one idle for 30 minutes, binds each
to the credential that initialized it, and answers 404 for a session it no
longer holds — the transport's signal to initialize again. On the hosted
worker that state is per isolate. A destructive tool's confirmation rides the
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
