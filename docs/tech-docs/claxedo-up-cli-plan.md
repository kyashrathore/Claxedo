# `claxedo up`

Status: retained code-grounded reference
Last updated: 2026-07-09

This document is retained because `public-docs/hosted-control-plane-worker.md`
cites it for the CLI/device-login phase.

## Current Implementation

- CLI entrypoint: `packages/cli/src/index.ts`
- `claxedo login`: `packages/cli/src/auth/device-code.ts`
- token storage/refresh: `packages/cli/src/auth/token-store.ts`
- `claxedo up`: `packages/cli/src/commands/up.ts`
- host registration/heartbeat:
  `packages/cli/src/host/register.ts`
- local runtime startup: `packages/cli/src/host/runtime.ts`
- host state: `packages/cli/src/host/state.ts`
- `claxedo down`: `packages/cli/src/commands/down.ts`

## Current Flow

1. `claxedo login` calls `POST /api/auth/device/code`, opens the verification
   URL, polls `POST /api/auth/device/token`, and stores the returned access and
   optional refresh token.
2. `claxedo up [path]` registers or reuses a workspace, performs the
   user-hosted challenge/register handshake, starts a local workspace runtime,
   and prints `${appUrl}/w/${workspaceId}`.
3. `--detach` respawns the host process in the background and waits for a saved
   host record.
4. `claxedo down [workspaceId]` pauses the user-hosted link and removes local
   host state.

## Server Surfaces

- Device login: `packages/claxedo-server/src/routes/hosted/device-auth.ts`
- Hosted workspace registration:
  `packages/claxedo-server/src/routes/hosted/workspace.ts`
- Local (user-hosted) machine registration:
  `packages/claxedo-server/src/routes/hosted/host-enrollment.ts`
- Host tunnel client:
  `packages/workspace-runtime/src/workspace-relay-host-tunnel.ts`
- Hosted app composition:
  `packages/claxedo-server/src/deployments/hosted-shared/hosted-app.ts`

## Configuration

The hosted control plane composes device-login provider settings from
`packages/claxedo-server/src/authority/hosted-services.ts`. If no
`CLAXEDO_DEVICE_LOGIN_ISSUER` is configured, device-login routes fail closed
with `device_login_unconfigured`.

## Maintenance Rule

Keep this file as a current implementation pointer. Do not reintroduce hosted
deployment roadmaps or old milestone checklists here.
