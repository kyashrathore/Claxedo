# Claxedo

Claxedo is a cloud/hosted coding-agent platform built on the [OpenCode](https://github.com/anomalyco/opencode) engine. This is a hard fork: the OpenCode engine and shared UI are vendored in-repo as first-party source (bumped deliberately, not synced via merge), and everything else here is Claxedo's own — the control plane, workspace runtime, relay, channels, connections, workgraph, and the web/desktop apps.

## Layout

- `packages/claxedo-server` — control plane (embeds the OpenCode engine, runs local/cloud/hybrid sessions)
- `packages/claxedo-app` — web app (Solid); `packages/claxedo-desktop` — Electron shell
- `packages/workspace-runtime`, `workspace-relay*`, `sandbox-manager` — session execution + routing
- `packages/{channels,connections,workgraph,wakes,mcp,agent-*}` — first-party `@claxedo/*` capabilities
- `packages/{opencode,core,server,protocol,schema,plugin,llm,codemode,tui,ui,session-ui,sdk,http-recorder}` — vendored OpenCode engine + shared UI (load-bearing dependencies)
- `packages/cli` — the `claxedo deploy` CLI (`lildax`)

## Develop

```sh
bun install
bun run dev:web        # web app
bun run dev:desktop    # desktop shell
bun typecheck          # turbo typecheck across the workspace
```

Claxedo deploys via Fly and the `claxedo deploy` CLI. See `docs/` and `public-docs/` for architecture and deployment guides.
