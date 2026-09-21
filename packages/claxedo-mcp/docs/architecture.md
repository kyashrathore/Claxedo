# Architecture

`@claxedo/mcp` is a route, not a process. `createClaxedoMcpRoutes(options)` in
`src/server.ts` returns a Hono app for `/api/claxedo/mcp`; a composition
mounts it and supplies, through `FirstPartyMcpOptions`, the two things the
route cannot know by itself — how to verify a credential and how to build the
client the tools call.

## One request

1. **Loopback gate** (`mount: "loopback"` only). `endpoint/loopback.ts`
   requires the socket peer — stamped from the serving adapter, or read off
   the node-server request internals — to be a loopback address whenever one
   is resolvable, and requires the request URL's host and, when present, the
   `Origin` header to name loopback (`127.0.0.1`, `localhost`, `::1`).
   Anything else is 403 before a credential is read. The route sets no CORS
   header of its own, and the desktop-local composition excludes the path
   from its CORS policy.
2. **Credential.** The bearer is read from `Authorization` only. A loopback
   mount hands it to `verifyRuntimeCredential`, the issuer of the runtime
   that mounted the route; the claims become a `runtime` credential carrying
   the runtime id, workspace id, the user the runtime serves, and
   `?session=<id>` from the URL. A hosted or node mount asks
   `resolveUserCredential` first and falls back to the runtime verifier when
   it has one. No credential is 401 with a `WWW-Authenticate` challenge;
   hosted and node add `resource_metadata` pointing at
   `/.well-known/oauth-protected-resource`. `readOnly` applies to runtime
   credentials; a user credential's read-only state is the resolver's.
3. **In-flight cap.** `endpoint/in-flight.ts` counts open POSTs per
   credential key (runtime id + workspace + session, or actor + client). The
   count is released when the response body settles, so a tool that waits
   holds its slot for the whole wait. Over the cap is 429.
4. **Session.** `endpoint/sessions.ts` maps `Mcp-Session-Id` to a
   `WebStandardStreamableHTTPServerTransport` plus its `McpServer`, ordered by
   last use, bounded, idle-expiring, and bound to the credential key that
   initialized it. A request naming a session the store does not hold — or
   holds for another credential — is 404, which the streamable-HTTP transport
   defines as "initialize again". A request without a session id builds a
   fresh server; if it was not an `initialize`, the SDK answers 400 and the
   server is closed.
5. **Server.** A new `McpServer` is built for the credential: `createClient`
   produces the `ClaxedoMcpClient`, `createToolRegistry` receives a
   `McpToolContext` `{ credential, client, elicit, audit }`, and every group in
   `registerTools` registers against it. Tools outside the credential's
   audience, scope, or read-only state are never registered. With nothing
   listed, `tools/list` still answers an empty list.
6. **Transport.** `transport.handleRequest(request)` does the rest: SSE for
   POST responses, the standalone GET stream, DELETE to end the session.

## Elicitation

`ctx.elicit` is a getter that yields `server.elicitInput` only after the
client's `initialize` declared the elicitation capability; before that, and
for hosts without it, it is undefined and a destructive tool runs unconfirmed
(the server-side check on the real operation is the boundary). The route
tracks open `tools/call` ids on the transport; when exactly one is open the
elicitation is sent with `relatedRequestId`, so it rides the SSE stream of
that call — the one stream every host reads. With several calls open it
falls back to the standalone GET stream.

Stateless mode was rejected for this reason: the client's answer to an
elicitation arrives as a new POST, and only a server that still exists can
receive it.

## Audit

The registry calls `ctx.audit` before every write with the tool, the
credential, the arguments, and the session the write addresses.
`mcpAuditRecord` flattens that to `{ tool, actor, client, sessionId?,
workspaceId?, callerSessionId? }`. The hosted worker and the node record it
through `WorkspaceAuthority.auditAllow` as the signed caller (action
`mcp.<tool>`); the desktop-local server and the cloud runtime write a log
line (`mcp.audit`) from their own loggers.

## Mounts

`McpClientInputs` is what a mount can offer the client factory:

- `local` — the runtime in this process and the workspace it serves. The
  desktop-local server and the node bind their app's own in-process fetch to
  the credential's workspace with `x-workspace-id`, which their runtime proxy
  reads; the node leaves the workspace unnamed for an account credential, so
  the client names it per call. The cloud runtime's fetch re-enters its own
  app; under relay exposure it carries a process-private bearer that
  relay-host auth accepts as a direct token.
- `controlPlane` — the composed app's in-process fetch with the caller's
  `Authorization` forwarded. Hosted and node supply it for user credentials.
  The desktop-local server has no account credential to act with and supplies
  none; a cloud runtime's exchange of its credential for a user grant is not
  built here.

The hosted worker and the node share `packages/claxedo-server/src/mcp/first-party-mcp.ts`,
which turns a signed control-plane identity into a user credential (actor id
from the principal, `cli` as the client) and keeps the identity beside the
credential for the audit sink. The node adds the unsigned loopback branch:
`actorId: "loopback"`, `clientId: "loopback"`, every scope — the same trust
every other route on an unsigned box extends a loopback caller.
