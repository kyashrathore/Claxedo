---
date: 2026-04-29
topic: portless-process-routing-integration
status: active
origin: chat
---

# Portless Named URLs (Opt-In, Local Only)

## Goal

Surface stable, named URLs (e.g. `web.myapp.localhost`) for processes in the process pane, by registering Claxedo-picked app ports as Portless routes when Portless is installed. When Portless is not installed, behavior is unchanged.

This is a quality-of-life feature on top of the existing process supervisor. Portless does **not** pick ports, supervise processes, or replace any Claxedo machinery — it only provides name-to-port mapping and a single shared local proxy.

## Non-Goals

The following were considered and explicitly cut:

- **No cloud changes.** Cloud workspaces run one runtime per VM; cross-workspace port collisions don't exist there. Cloud preview URLs continue to flow through `claxedo-server`'s existing `workspaceRuntimeProxy()`. No `claxedo-server` changes in this plan.
- **No replacement of `portpick.ts` / `lease.ts`.** Portless does not pick free ports; `portpick` still picks the app port. Portless registers an alias on top of the picked port. The "remove legacy portpick" motion in earlier drafts was a misread.
- **No route abstraction layer / provider union / `ManagedProcess.route` sub-object.** Too heavy for an opt-in feature. The launch path takes a thin direct dependency on a small Portless helper.
- **No `{{url:name}}` env templating.** Single-provider scope; existing `{{port:name}}` is unchanged. Add later if a real consumer asks.
- **No diagnostics changes.** The user-started Portless proxy correctly classifies as `external`. We do not introduce a `portless_proxy` owner kind.
- **No proxy supervision.** Claxedo never starts `portless proxy start`. The user is responsible for the proxy's lifecycle.

## Activation Model

**Auto-detect per process start.** No user setting, no config flag.

On each `start()` call, read Portless state from `~/.portless`:

- `proxy.pid` — exists, parses to int, and `kill(pid, 0)` succeeds → proxy alive
- `proxy.port` — exists, parses to int → proxy port number
- `tls` — file exists → use `https`, else `http`
- `tld` — optional override; defaults to `localhost`

If any of these checks fail, skip route registration silently. The process starts exactly as today; `namedUrl` stays `undefined`; the UI shows `http://localhost:${assignedPort}` as before.

Escape hatch: `CLAXEDO_DISABLE_PORTLESS=1` short-circuits detection. Five lines, no UI surface.

## Library Boundary

Use the public Portless library exports only. No deep imports.

```ts
import { RouteStore, formatUrl } from "portless"
```

- `RouteStore(dir)` for `addRoute(hostname, port, pid, force)`, `loadRoutes()`, `removeRoute(hostname)`. The store filters dead PIDs on every read, so no explicit cleanup is needed when our process exits.
- `formatUrl(hostname, proxyPort, tls)` for the displayed URL string.
- The 4 file reads (`proxy.pid`, `proxy.port`, `tls`, `tld`) are reimplemented in our helper — they're trivial and avoid coupling to Portless's not-public `cli-utils.ts`.

Pin a Portless version range in `packages/workspace-runtime/package.json` so file conventions can't drift unexpectedly.

## Hostname Rule

```
default:          ${sanitize(port.name)}.${sanitize(workspaceName)}.localhost
on pick-new:      ${sanitize(port.name)}.${sanitize(workspaceName)}-${workspaceId.slice(0,6)}.localhost
```

Where:

- `workspaceName = workspace_name ?? project_name ?? repo_name ?? basename(directory)`. All sanitized.
- `sanitize(s)` = lowercase, replace `[^a-z0-9-]` with `-`, collapse runs of `-`, trim leading/trailing `-`. Same shape as Portless's `sanitizeForHostname`, reimplemented in ~6 lines so we don't depend on `auto.ts`.
- `workspaceId.slice(0,6)` is a 6-char prefix of the `Workspace.id` UUID. Stable across restarts, unique per workspace, eliminates collisions deterministically. No retry loop, no numeric suffix counters.
- TLD is `localhost` unless `~/.portless/tld` overrides it.

The hostname is recomputed on every process start. If the user renames `workspace_name`, the change applies on the next start. Documented; no rename → re-register pipeline.

When `workspaceId` is unavailable (workspace not bound), skip naming entirely — `namedUrl` stays `undefined`. No fallback discriminator.

## Workspace Name Plumbing

`workspace_name` lives in `claxedo-server/src/workspace-store.ts` but is needed in `workspace-runtime` at process-start time.

Add `x-workspace-name` header alongside the existing `x-workspace-id` header:

- `packages/workspace-runtime/src/process/client.ts` — set `x-workspace-name` from `Input.workspaceName`.
- `packages/workspace-runtime/src/process/index.ts` — read header, extend `bindWorkspace(directory, workspaceId, workspaceName?)`. Store both in `workspaceMap` (now value-shaped: `{ id, name? }`). Expose `workspaceName(directory)` helper alongside the existing `workspace(directory)` helper.
- Caller in `claxedo-server` populates the field from the `Workspace` record before each request.

~30 lines spread across the boundary. The header pattern matches existing precedent (`x-workspace-id`).

## Schema Deltas

In `packages/workspace-runtime/src/process/process.ts`:

```ts
ManagedProcess += {
  namedUrl?: string
}

RouteConflictInfo = z.object({
  type: z.literal("route-conflict"),
  hostname: z.string(),
  pid: z.number().int(),
  command: z.string().optional(),
  processName: z.string().optional(),
  processId: z.string().optional(),
  directory: z.string().optional(),
})

LaunchResult discriminated union += {
  kind: "route_conflict"
  conflict: RouteConflictInfo
}

LaunchRequest += {
  routeConflict?: PortConflictStrategy   // reuse "pick-new" | "kill-existing"
}
```

Strategies are symmetric with port-conflict: `PortConflictStrategy` is reused, not duplicated.

## Launch Lifecycle

In `start()` (`index.ts` ~860–1015):

1. Existing prelude: dependency starts, `resolvePort()` → `assignedPort`.
2. **Pre-launch dry-run.** If Portless is detected:
   - Compute the target hostname. If `routeConflict === "pick-new"`, use the discriminator-appended form.
   - `loadRoutes()`, find any entry with `hostname === target` whose `pid` is alive.
   - If found and `routeConflict !== "kill-existing"`: return `LaunchResult.route_conflict` with info populated. PTY never spawns.
3. Existing PTY spawn, command write, `registerPort()`, lease write — unchanged.
4. **Post-spawn `addRoute`.** Right after `registerPort()`:
   - `addRoute(target, assignedPort, info.pid, force = (routeConflict === "kill-existing"))`.
   - On `RouteConflictError` (race lost between dry-run and now): SIGKILL `info.pid`, clean up `proc`, return `LaunchResult.route_conflict`.
   - On other errors: log warn, continue without `namedUrl`. Never block the process from starting.
   - On success: `proc.namedUrl = formatUrl(target, proxyPort, tlsEnabled)`.
5. Existing event publishing — unchanged.

PID semantics:
- We register `info.pid` (the PTY shell). Shell exits when the user's command exits → Portless's PID-liveness filter drops the route automatically. No explicit `removeRoute` needed.
- `stop()` already SIGKILLs `info.pid` (`index.ts:768`, `1065-1087`). Restart of a crashed process calls `stop()` first (`index.ts:869-871`), so the old shell PID is dead before re-registration. `force: false` is correct on auto-retry.

`force: true` is **only** used when the user explicitly chose `kill-existing` for the route conflict. We never auto-steal a sibling workspace's hostname.

## Conflict Resolution UI

Reuse the existing port-conflict dialog component. It already handles a discriminated `conflict` shape with two buttons. Bind to `route_conflict` variant of `LaunchResult`:

- **Pick a new name** → re-launch with `routeConflict: "pick-new"`. Hostname becomes `${name}.${workspace}-${id6}.localhost`. Deterministic, one call.
- **Take over** → re-launch with `routeConflict: "kill-existing"`. `force: true` SIGTERMs the existing PID (which may be a sibling Claxedo workspace's process — same risk profile as `kill-existing` for ports today).

Conflict info populates `command`, `processName`, `processId`, `directory` when the conflicting PID matches a Claxedo-managed process in another workspace (cross-reference via `workspaceMap`). Same lookup pattern as `PortConflictInfo`.

## UI Rendering

`packages/claxedo-app/src/claxedo-ui/workspace-panel/ProcessPanePanel.tsx`:

When `process.namedUrl` is present:
- Primary: clickable link to `process.namedUrl`.
- Secondary: small label `localhost:${assignedPort}` underneath, copy-on-click. Preserved because curl scripts, framework proxy configs, and devtools port-pinning still need the raw port.

When absent (Portless not installed, race-loss, or `workspaceId` unknown):
- Primary: clickable link to `http://localhost:${assignedPort}`. Today's behavior.

The route-conflict dialog flow blocks process start, so there is no "conflict at rest" rendering — by the time a `ManagedProcess` exists, the conflict has been resolved.

## MCP Surface

`packages/claxedo-server/src/claxedo-mcp/process-handler.ts`:

Add `namedUrl` to the formatted output when present. Agents that ignore the field get today's behavior; agents that read it get a stable URL to reference in tickets, docs, and follow-up tasks.

No new tool, no `routeConflict` exposure to agents, no auto-resolution by agents.

## Validation

Package-local checks only:

- `packages/workspace-runtime`: `bun test`, `bun typecheck`
- `packages/claxedo-server`: `bun test`, `bun typecheck`
- `packages/claxedo-app`: targeted vitest for `ProcessPanePanel.tsx`, `bun typecheck`

Manual validation:

1. Without Portless installed → start a process. URL is `localhost:port`. Stop. Behavior identical to today.
2. Install `portless`, run `portless proxy start`. Start the same process. URL becomes `${name}.${workspace}.localhost`. The `localhost:port` label is still shown underneath.
3. Open a second Claxedo workspace with the same `port.name` and same `workspace_name`. Start the process. Conflict dialog appears.
   - Pick "Take over" → sibling process is SIGTERM'd, this workspace owns the route.
   - Pick "Pick a new name" → URL becomes `${name}.${workspace}-${id6}.localhost`.
4. Crash a process (bad command). Re-run from UI. Route is re-registered cleanly (existing `stop()`-before-restart kills the old shell PID).
5. Stop a process. Hit the named URL → 502 within ~milliseconds (PID liveness filters the dead route on next read).

## Risks

- **Portless file format drift.** Our helper reads `proxy.pid`, `proxy.port`, `tls`, `tld` directly. If a Portless minor version renames any of them, named URLs silently disappear. Mitigation: pin a version range; the helper fails closed (no namedUrl, no exception).
- **HTTPS trust setup.** If TLS is enabled but the user hasn't installed Portless's cert, the URL works but the browser shows a warning. We don't try to detect or surface this. Acceptable for v1; user-facing fix is `portless proxy start` documentation.
- **`kill-existing` on routes can SIGTERM a sibling Claxedo process.** Same risk profile as today's `kill-existing` for ports. Only fires on explicit user choice from the dialog.
- **Race window between dry-run and `addRoute`.** Possible in theory, vanishingly rare in practice (the discriminator-suffixed hostname is unique to this workspace). Handled by SIGKILL + return `route_conflict`.

## Sequence

Three PRs, ~600 LoC total.

**PR 1 — Schema + plumbing.**
- Schema deltas in `process.ts` (`namedUrl`, `RouteConflictInfo`, `LaunchResult.route_conflict`, `LaunchRequest.routeConflict`).
- `x-workspace-name` header in `process/client.ts`.
- `bindWorkspace(directory, workspaceId, workspaceName?)`, `workspaceName(directory)` helper in `process/index.ts`.
- `claxedo-server` callers populate the new header from the `Workspace` record.
- No functional change visible to users.

**PR 2 — Portless integration.**
- New `process/portless.ts` (~80 lines): `detectProxy()`, `deriveHostname()`, `dryRunCheck()`, `tryRegister()`. Imports `RouteStore`, `formatUrl` from `portless`.
- Wire into `start()` per the lifecycle above.
- Tests:
  - hostname derivation (sanitization, fallback chain, `pick-new` discriminator append, missing workspaceId)
  - launch path with mocked `RouteStore` (no Portless installed, conflict dry-run, race loss, success)
  - existing `applyRestartPolicy` auto-restart still works
- Add `portless` to `packages/workspace-runtime/package.json` with a pinned version range.

**PR 3 — UI + MCP.**
- `ProcessPanePanel.tsx`: primary `namedUrl` + secondary `localhost:port`.
- Conflict dialog binding for `route_conflict` LaunchResult.
- `process-handler.ts`: include `namedUrl` in formatter.
- Vitest coverage for the rendering branches.

## Edge Cases (Explicit)

- **No `workspaceId` bound** → skip naming, no namedUrl, UI falls back to `localhost:port`.
- **Portless library throws unexpectedly** (lock contention, disk full, schema mismatch) → catch, log warn, no namedUrl. Never block process start.
- **Auto-restart from `applyRestartPolicy`** → goes through `start()`, same dry-run + addRoute flow. Tested.
- **`workspace_name` is renamed mid-session** → no immediate effect. Hostname recomputes on next `start()`.
- **User stops Portless proxy mid-session** → existing `namedUrl` becomes a 502 on click. New process starts skip naming. Acceptable; `localhost:port` keeps working for everything new.

## Success Criteria

- With Portless installed and proxy running, every Claxedo-managed process with a `port.name` shows a named URL in the process pane and in MCP output.
- Without Portless, every existing flow behaves byte-identically to today.
- Two Claxedo workspaces with colliding `port.name` + `workspace_name` produce a route-conflict dialog with the same UX shape as the existing port-conflict dialog.
- No changes to: cloud preview, `portpick.ts`, `lease.ts`, diagnostics, process supervisor, dependency ordering, env templating.
