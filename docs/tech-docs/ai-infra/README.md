# Composable AI Infra

Status: retained code-grounded architecture note
Last updated: 2026-07-09

This note is retained because
`packages/claxedo-app/src/overrides/README.md` links here as the active Claxedo
architecture pointer. Keep it concise and grounded in current package paths.

## Current Package Boundaries

- `packages/claxedo-server`
  - Hosted and local control plane composition.
  - Public host primitives exported from `src/index.ts`, including auth
    adapters, projection/session-log stores, channel delivery/audit helpers,
    mirror controller, and sandbox-manager re-exports.
  - Hosted Worker-safe app in `src/hosted-app.ts`.
- `packages/workspace-runtime`
  - Workspace host service, process/PTY/file/VCS routes, runtime store, relay
    host tunnel, and embedded runtime surface.
- `packages/agent-sdk-runtime`
  - Harness-facing session runtime APIs.
  - Current runner code lives under `src/harnesses/*`, with shared runtime-store,
    turn-projection, SSE, capability, and target helpers at the package root.
- `packages/agent-event-runtime`
  - Provider/harness event translation, diagnostics, canonical runtime events,
    and OpenCode-compatible projections.
  - Current provider code lives under `src/harnesses/*` and
    `src/projections/*`.
- `packages/agent-extensions`
  - Extension discovery, fetch/cache, lock/state, materialization, runtime
    config, and replay helpers.
- `packages/workspace-relay` and `packages/workspace-relay-protocol`
  - Remote workspace transport, target resolution, token verification, and
    relay protocol contracts.
- `packages/sandbox-manager`
  - Sandbox lease/driver lifecycle. `claxedo-server` composes it through
    `workspace-supervisor-sandbox.ts` and hosted sandbox admin routes.

## Code Grounding

Use these files as the current source of truth before changing this note:

- `packages/claxedo-server/src/index.ts`
- `packages/claxedo-server/src/hosted-app.ts`
- `packages/claxedo-server/src/control-plane/services.ts`
- `packages/claxedo-server/src/control-plane/hosted-services.ts`
- `packages/claxedo-server/src/workspace-supervisor-sandbox.ts`
- `packages/workspace-runtime/src/index.ts`
- `packages/workspace-runtime/src/workspace-relay-host-tunnel.ts`
- `packages/agent-sdk-runtime/src/index.ts`
- `packages/agent-sdk-runtime/src/harnesses/index.ts`
- `packages/agent-event-runtime/src/index.ts`
- `packages/agent-event-runtime/src/projections/opencode-compat/ownership.ts`
- `packages/agent-extensions/src/index.ts`

## Maintenance Rule

Do not add speculative target APIs, old phase plans, or release rubrics here.
If a detailed architecture doc is needed, ground every referenced file path in
current code and keep the doc directly linked from source, tests, or public
docs.
