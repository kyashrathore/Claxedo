# Claxedo

![npm version](https://img.shields.io/npm/v/%40claxedo%2Fworkspace-runtime.svg)
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

**[claxedo.com](https://claxedo.com) · [npm: @claxedo/*](https://www.npmjs.com/search?q=%40claxedo)**

Claxedo is an open-source coding-agent workspace for running OpenCode, Claude, Codex, Cursor, Pi, and other coding agents against your own projects. It combines first-class chat and terminal sessions, remote workspace access, sandbox management, WorkGraph, MCP tooling, and portable Agent Extensions.

## Quickstart

Clone the repo and run the desktop app or the engine directly:

```sh
git clone https://github.com/kyashrathore/Claxedo.git
cd Claxedo
bun install
bun run dev             # OpenCode engine (CLI/server)
bun run dev:desktop     # desktop app (Electron shell)
bun typecheck           # turbo typecheck across the workspace
```

The runtime packages remain independently installable for Node and Bun projects:

```sh
npm install @claxedo/workspace-runtime @claxedo/agent-sdk-runtime @claxedo/agent-event-runtime
```

Most full products start with `@claxedo/workspace-runtime`; the package table below links directly to each published module.

## Packages

All 12 are published on npm under [`@claxedo/*`](https://www.npmjs.com/search?q=%40claxedo):


| Package                                                                                                | Description                                                                                                                             |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| [`@claxedo/workspace-runtime`](https://www.npmjs.com/package/@claxedo/workspace-runtime)               | Per-workspace host runtime for agent sessions, terminals, processes, files, diffs, and relay attachment                                 |
| [`@claxedo/agent-sdk-runtime`](https://www.npmjs.com/package/@claxedo/agent-sdk-runtime)               | Runtime facade over coding-agent harnesses (Claude, Codex, Cursor, OpenCode, Pi): sessions, turns, SSE routes, pluggable stores         |
| [`@claxedo/agent-event-runtime`](https://www.npmjs.com/package/@claxedo/agent-event-runtime)           | Canonical agent event contracts and harness adapters normalizing Claude SDK, Codex, Cursor, and ACP event streams into one event model  |
| [`@claxedo/agent-extensions`](https://www.npmjs.com/package/@claxedo/agent-extensions)                 | Install and materialize reusable agent capabilities (skills, MCP configs, plugins) into Codex, Claude, OpenCode, and Cursor             |
| [`@claxedo/workspace-relay`](https://www.npmjs.com/package/@claxedo/workspace-relay)                   | Relay/tunnel server that routes authenticated traffic to workspace runtimes, with Bun and Cloudflare adapters                           |
| [`@claxedo/workspace-relay-protocol`](https://www.npmjs.com/package/@claxedo/workspace-relay-protocol) | Wire types, message validation, and token verifier interfaces for the workspace relay tunnel protocol                                   |
| [`@claxedo/sandbox-manager`](https://www.npmjs.com/package/@claxedo/sandbox-manager)                   | Sandbox lifecycle manager with epoch-based leases and pluggable drivers for Daytona, Modal, Vercel Sandbox, Cloudflare, Box, and Docker |
| [`@claxedo/channels`](https://www.npmjs.com/package/@claxedo/channels)                                 | Channel ingress routing GitHub, Slack, Telegram, Discord, and WhatsApp messages into Claxedo runtimes                                   |
| [`@claxedo/connections`](https://www.npmjs.com/package/@claxedo/connections)                           | Integration registry, credential store ports, OAuth attempt machine, and token service for linking external accounts                    |
| [`@claxedo/mcp`](https://www.npmjs.com/package/@claxedo/mcp)                                           | MCP server and CLI for Claxedo documents, WorkGraph, processes, logs, sessions, and browser tools                                       |
| [`@claxedo/workgraph`](https://www.npmjs.com/package/@claxedo/workgraph)                               | A personal operating system for organizing, executing, and remembering AI-assisted work                                                 |
| [`@claxedo/wakes`](https://www.npmjs.com/package/@claxedo/wakes)                                       | Resume an idle agent session from an out-of-band trigger — a durable wake fired by time, an external event, or an authorized approval   |


## Layout

- `packages/claxedo-server` — control plane (embeds the OpenCode engine, runs local/cloud/hybrid sessions)
- `packages/claxedo-app` — web app (Solid); `packages/claxedo-desktop` — Electron shell
- `packages/workspace-runtime`, `workspace-relay*`, `sandbox-manager` — session execution + routing
- `packages/{channels,connections,workgraph,wakes,mcp,agent-*}` — first-party `@claxedo/*` capabilities
- `packages/{opencode,core,server,protocol,schema,plugin,llm,codemode,tui,ui,session-ui,sdk,http-recorder}` — vendored OpenCode engine + shared UI (load-bearing dependencies)
- `packages/cli` — the `claxedo deploy` CLI (`lildax`)

## OpenCode heritage

Claxedo is a hard fork of [OpenCode](https://github.com/anomalyco/opencode) — the engine and shared UI packages are vendored in-repo as first-party source; everything else (control plane, workspace runtime, relay, channels, connections, workgraph, web/desktop apps) is Claxedo's own.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Security issues go through [SECURITY.md](./SECURITY.md), not a public issue.

## License

MIT — see [LICENSE](./LICENSE).
