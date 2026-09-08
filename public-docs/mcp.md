# Claxedo MCP

Claxedo serves one MCP endpoint, `/api/claxedo/mcp`, from every process that
runs it. An agent in any MCP-capable host — Claude Code, Codex, Cursor,
Claude Desktop, a phone — connects to it over streamable HTTP and drives
Claxedo through tools. Nothing is installed from npm and nothing runs over
stdio: the endpoint is whatever the running Claxedo ships, so there is no
version to fall behind and no port to get wrong.

## Where the endpoint is

| You are connecting from | URL | Credential |
| --- | --- | --- |
| Any app you install Claxedo MCP in | `https://<your control plane>/api/claxedo/mcp` | the CLI sign-in (`~/.claxedo/credentials.json`) as a bearer, or the OAuth consent the client drives when it receives the endpoint's challenge |
| A self-hosted node | `https://<node>/api/claxedo/mcp` | as above; on an unsigned node, a loopback caller needs none |
| A session Claxedo launched, on your machine or in a cloud VM | the loopback URL of the runtime that launched it | injected by that runtime at launch, together with `?session=<id>`; nothing else is accepted there |

The loopback URLs are never something you configure. The runtime places them
in the harness config of each session it starts; every app a person installs
Claxedo MCP in uses the hosted URL, even on the same machine as the desktop.

## Installing by URL

Add the hosted URL the way the host adds any remote MCP server:

```sh
claude mcp add --transport http claxedo https://<your control plane>/api/claxedo/mcp
codex mcp add claxedo --url https://<your control plane>/api/claxedo/mcp
```

For a client that speaks MCP OAuth, the first request is answered `401` with
`WWW-Authenticate: Bearer resource_metadata="https://<your control plane>/.well-known/oauth-protected-resource"`,
and the client takes it from there. A client that already holds the CLI
sign-in sends it as `Authorization: Bearer …`.

## What the agent sees

The credential decides which tools the endpoint lists:

- the **runtime credential** a launched session carries sees the tools for
  the model inside a Claxedo session — its own workspace, subagents,
  processes, the transcripts it may read;
- a **user credential** sees the tools for a person on another host —
  sessions across machines, what needs attention and how to answer it,
  workspaces and machines, review.

A read-only credential sees no write. A tool the credential was not shown is
not registered at all, so calling it anyway is answered as an unknown tool.
A destructive tool asks the host to confirm through MCP elicitation when the
host declares that capability (Claude Code and Codex CLI do); the server's
own check on the operation stands either way.

## Sessions and limits

The endpoint keeps a session per `Mcp-Session-Id`. A session idle for 30
minutes, or evicted when a process holds more than 256, is answered `404`,
which tells the client to initialize again. One credential may hold 8
requests open at once; the ninth is `429` with `Retry-After: 1`.

## Security

- The loopback endpoint accepts only the credential the runtime injected,
  read from the `Authorization` header and never from the URL; it rejects a
  request whose `Host` or `Origin` is not loopback and reflects no CORS
  origin, so a page cannot drive it from a browser.
- The hosted endpoint treats the CLI sign-in as the whole account: every
  scope, nothing read-only.
- Every write is recorded with the actor, the client (OAuth client id, `cli`,
  or the runtime instance) and the session it addressed: on the control plane
  through its authority audit, on a machine or VM in that process's log.
