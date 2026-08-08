import { describe, expect, test } from "bun:test"
import path from "node:path"

// CI invariants for the WorkspaceConnection authority (in the spirit of
// `utils/workspace-runtime-route-audit.test.ts`). These pin the structural
// properties that make "one connection authority" hold:
//   1. Single writer — only `workspace-connection.ts` mutates the store.
//   2. One connecting screen — `WorkspaceOfflineView` lives behind the gate.
//   3. `useWorkspaceQuery` bakes in `enabled: isWorkspaceReady(...)`.
//
// NOTE: consumer migration (session.tsx / directory-scope.tsx gates → the gate)
// is a LATER phase. The `CloudStartupView`/`WorkspaceAccessDeniedView` importer
// allowlist below is the explicit shrink-list for that migration; as each
// pre-gate consumer is deleted it is removed from the allowlist, and the final
// state is `{ workspace-gate.tsx }` only.

const root = path.resolve(import.meta.dir, "../../..")

const moduleDir = "features/workspaces/data"
const authorityModule = `${moduleDir}/workspace-connection.ts`
const gateModule = `${moduleDir}/workspace-gate.tsx`
const wrapperModule = `${moduleDir}/use-workspace-query.ts`

// The ONLY component that renders the connecting/offline/access-denied screens
// is the gate. `WorkspaceOfflineView` is brand-new and pinned to the gate now.
// `CloudStartupView` / `WorkspaceAccessDeniedView` additionally have these
// pre-migration importers (tracked shrink-list — must only ever decrease):
const connectingUiAllowlist = new Set([
  gateModule,
  "features/session/ui/components/cloud-startup-view.tsx", // the definition module
  // ── pre-gate consumers (delete during migration Steps 2–3) ──
  // directory-scope.tsx was removed from this list in Step 3: its parallel
  // startup gate (CloudStartupView + resolveWorkspaceRuntime + provision
  // listener) was collapsed — the connecting UI is owned by WorkspaceGate now.
  "features/session/ui/session-screen.tsx",
  "features/session/actions/session-actions.tsx",
])

async function files(): Promise<string[]> {
  const out: string[] = []
  for (const entry of await Array.fromAsync(new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: root }))) {
    if (entry.endsWith(".d.ts")) continue
    if (entry.includes(".test.") || entry.includes(".vitest.")) continue
    out.push(entry)
  }
  return out
}

async function read(rel: string) {
  return await Bun.file(path.join(root, rel)).text()
}

describe("workspace connection authority invariants", () => {
  test("single writer: the connection store mutator never leaves workspace-connection.ts", async () => {
    const offenders: string[] = []
    for (const file of await files()) {
      if (file === authorityModule) continue
      const text = await read(file)
      // No other module may import or reference a store setter for the
      // connection store. The module never exports `setWorkspaceConnection`.
      if (/\bsetWorkspaceConnection\b/.test(text)) offenders.push(`${file}: references setWorkspaceConnection`)
      if (/from\s+["'][^"']*workspace-connection["']/.test(text) && /\bsetConnections\b/.test(text)) {
        offenders.push(`${file}: imports the raw connection store setter`)
      }
    }
    expect(offenders).toEqual([])
  })

  test("single writer: the authority does NOT export a raw store setter", async () => {
    const text = await read(authorityModule)
    // `acquireWorkspaceConnection` is the only exported MUTATOR; predicates are
    // read-only. There must be no `export ... setWorkspaceConnection`.
    expect(text).not.toMatch(/export\s+(?:const|function)\s+setWorkspaceConnection\b/)
    expect(text).toMatch(/export function acquireWorkspaceConnection\b/)
    expect(text).toMatch(/export function workspaceConnection\b/)
    expect(text).toMatch(/export function isWorkspaceReady\b/)
    expect(text).toMatch(/export function workspaceOffline\b/)
  })

  test("one connecting screen: connecting UI is imported only inside the allowlist", async () => {
    // Match an actual import or JSX render of the connecting components — not a
    // mention in a comment (the authority's docstring names CloudStartupView).
    const importsOrRenders = (text: string, name: string) =>
      new RegExp(`import[^;]*\\b${name}\\b[^;]*from`).test(text) || new RegExp(`<${name}\\b`).test(text)

    const offenders: string[] = []
    for (const file of await files()) {
      const text = await read(file)
      const rendersConnecting =
        importsOrRenders(text, "CloudStartupView") || importsOrRenders(text, "WorkspaceAccessDeniedView")
      if (rendersConnecting && !connectingUiAllowlist.has(file)) {
        offenders.push(`${file}: renders connecting UI outside the gate`)
      }
      // WorkspaceOfflineView is new — it must live ONLY in the gate module.
      if (file !== gateModule && importsOrRenders(text, "WorkspaceOfflineView")) {
        offenders.push(`${file}: references WorkspaceOfflineView outside workspace-gate.tsx`)
      }
    }
    expect(offenders).toEqual([])
  })

  test("the gate holds no connection drive logic — it reads the authority", async () => {
    const text = await read(gateModule)
    // The gate acquires + reads predicates; it must NOT call the mint/health
    // primitives directly (that is the authority's job).
    expect(text).toMatch(/acquireWorkspaceConnection\b/)
    expect(text).toMatch(/workspaceConnection\b/)
    expect(text).not.toMatch(/prepareUserHostedRuntime\b/)
    expect(text).not.toMatch(/prepareWorkspaceRuntime\b/)
    expect(text).not.toMatch(/openWorkspaceConnection\b/)
  })

  test("useWorkspaceQuery bakes in workspace-ready gating and authority-owned retry", async () => {
    const text = await read(wrapperModule)
    expect(text).toMatch(/import .*isWorkspaceReady.* from .*workspace-connection/)
    expect(text).toMatch(/isWorkspaceReady\(/)
    // enabled is ANDed with the caller's enabled (never widened).
    expect(text).toMatch(/enabled:\s*ready\s*&&\s*\(opts\.enabled\s*\?\?\s*true\)/)
    // retry defaults off — the authority owns retry/backoff.
    expect(text).toMatch(/retry:\s*opts\.retry\s*\?\?\s*false/)
  })

  test("the authority reuses the existing mint/health/provision code (no duplication)", async () => {
    const text = await read(authorityModule)
    // Wave 1.5 flattened `cloud/runtime/` → `platform/runtime/cloud/workspace-runtime-store.ts`.
    //
    // The authority binds that hosted module DIRECTLY rather than through
    // `workspaceStartup()`, unlike every local caller: it is on Unit 10's move
    // list and leaves with the implementation, so a port between them would be
    // indirection that moves twice. `architecture/workspace-startup-port.guard.test.ts`
    // allowlists exactly this importer, with that reason.
    expect(text).toMatch(/from .*cloud\/workspace-runtime-store/)
    expect(text).toMatch(/prepareUserHostedRuntime\b/)
    expect(text).toMatch(/prepareWorkspaceRuntime\b/)
    // The log helper is NOT hosted — it appends to an array — so it comes from
    // `platform/runtime/workspace-log.ts`, which stays in `@claxedo/app`.
    expect(text).toMatch(/appendWorkspaceRuntimeLog\b/)
    expect(text).toMatch(/from ["']@\/platform\/runtime\/workspace-log["']/)
  })
})
