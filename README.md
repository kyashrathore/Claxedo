# Claxedo

![npm version](https://img.shields.io/npm/v/%40claxedo%2Fworkspace-runtime.svg)
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

**[claxedo.com](https://claxedo.com) · [npm: @claxedo/*](https://www.npmjs.com/search?q=%40claxedo)**

Claxedo is an open-source coding-agent workspace for running OpenCode, Claude, Codex, Cursor, Pi, and other coding agents against your own projects. It combines first-class chat and terminal sessions, remote workspace access, sandbox management, MCP tooling, and an optional standards-based Agent Plugins catalog.

## Quickstart

Clone the repo and run the desktop app or the engine directly:

```sh
git clone https://github.com/kyashrathore/Claxedo.git
cd Claxedo
bun install
bun run dev             # desktop app (Electron shell)
bun typecheck           # turbo typecheck across the workspace
```

The runtime packages remain independently installable for Node and Bun projects:

```sh
npm install @claxedo/workspace-runtime @claxedo/agent-runtime-contract
```

Most full products start with `@claxedo/workspace-runtime`; the package table below links directly to each published module.

## Packages

All 10 are published on npm under [`@claxedo/*`](https://www.npmjs.com/search?q=%40claxedo):


| Package                                                                                                | Description                                                                                                                             |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| [`@claxedo/workspace-runtime`](https://www.npmjs.com/package/@claxedo/workspace-runtime)               | Per-workspace host runtime for agent sessions, terminals, processes, files, diffs, and relay attachment                                 |
| [`@claxedo/agent-runtime-contract`](https://www.npmjs.com/package/@claxedo/agent-runtime-contract)     | Dependency-free canonical contracts for Claxedo agent sessions, content, execution, errors, and events                                  |
| [`@claxedo/workspace-relay`](https://www.npmjs.com/package/@claxedo/workspace-relay)                   | Relay/tunnel that routes authenticated traffic to workspace runtimes, deployed as a Cloudflare Worker                                   |
| [`@claxedo/workspace-relay-protocol`](https://www.npmjs.com/package/@claxedo/workspace-relay-protocol) | Wire types, message validation, and token verifier interfaces for the workspace relay tunnel protocol                                   |
| [`@claxedo/sandbox-contract`](https://www.npmjs.com/package/@claxedo/sandbox-contract)                 | Dependency-neutral sandbox driver identity and credential configuration contracts                                                       |
| [`@claxedo/sandbox-manager`](https://www.npmjs.com/package/@claxedo/sandbox-manager)                   | Sandbox lifecycle manager with epoch-based leases and pluggable drivers for Daytona, Modal, Vercel Sandbox, Cloudflare, Box, and Docker |
| [`@claxedo/channels`](https://www.npmjs.com/package/@claxedo/channels)                                 | Channel ingress routing GitHub, Slack, Telegram, Discord, and WhatsApp messages into Claxedo runtimes                                   |
| [`@claxedo/connections`](https://www.npmjs.com/package/@claxedo/connections)                           | Integration registry, credential store ports, OAuth attempt machine, and token service for linking external accounts                    |
| [`@claxedo/mcp`](https://www.npmjs.com/package/@claxedo/mcp)                                           | MCP server and CLI for Claxedo documents, processes, logs, sessions, and browser tools                                                  |


## Layout

- `packages/claxedo-server` — hosted control plane (runs local/cloud/hybrid sessions; embeds the published OpenCode SDK host via `@claxedo/workspace-runtime/opencode`)
- `packages/claxedo-local-server` — the desktop's local server; `packages/claxedo-server-core` — storage- and vendor-agnostic core shared by both servers
- `packages/claxedo-app` — web app (Solid); `packages/claxedo-desktop` — Electron shell
- `packages/workspace-runtime`, `workspace-relay*`, `sandbox-manager` — session execution + routing
- `packages/{channels,connections,mcp,agent-*}` — first-party `@claxedo/*` capabilities
- `packages/ui` — shared OpenCode UI used by the app and desktop
- `packages/cli` — the `claxedo` CLI (`@claxedo/cli`: `login`, `connect`, `host`, `status`, `deploy`, `documents`, `logout`); one-line install in [its README](./packages/cli/README.md)

## OpenCode heritage

Claxedo is a hard fork of [OpenCode](https://github.com/anomalyco/opencode). Session execution uses the pinned published OpenCode SDK through `packages/workspace-runtime`; shared UI remains in-repo, while benchmark imports use the same published SDK. The control plane, workspace runtime, relay, channels, connections, and web/desktop apps are Claxedo's own.

## Contributing

Security issues go through [SECURITY.md](./SECURITY.md), not a public issue.

## License

MIT — see [LICENSE](./LICENSE).
