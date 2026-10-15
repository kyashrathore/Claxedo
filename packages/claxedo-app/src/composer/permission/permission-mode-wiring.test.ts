/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { placementId as placement, projectId, sessionId, type HarnessConfigApi, type SessionRow } from "@/server"
import { connectionHarness, harnessSelectionValue, nativeHarness, type HarnessSelection } from "@/lib/harness-selection"
import { createComposerPermissionSurface } from "./permission-mode-wiring"

const placementId = placement("placement-1")
const ref = { projectId: projectId("project-1"), placementId, sessionId: sessionId("s1") }

function surface(harness: HarnessSelection, row?: Partial<SessionRow>) {
  const reads: unknown[] = []
  const api = {
    permissionModes: async (request: unknown) => {
      reads.push(request)
      return { modes: [{ id: "default", name: "Default" }], currentModeId: "default", appliesFrom: "next-turn" as const }
    },
  } as unknown as HarnessConfigApi
  const [selection] = createSignal(harness)
  const sessionRow = row ? { ref, title: "s1", createdAt: 1, updatedAt: 1, harness, ...row } : undefined
  const { permissionMode } = createComposerPermissionSurface({
    api,
    placementId: () => placementId,
    sessionRef: () => (sessionRow ? ref : undefined),
    sessionRow: () => sessionRow,
    harness: () => harnessSelectionValue(selection()),
    harnessSelection: selection,
    harnessUnavailable: () => undefined,
    onWriteFailed: () => undefined,
  })
  return { permissionMode, reads }
}

test("permission surface: a table harness names its modes and the row's mode with no read", () => {
  createRoot((dispose) => {
    const session = surface(nativeHarness("claude"), { permissionMode: "plan" })
    expect(session.permissionMode.current()?.id).toBe("plan")
    expect(session.permissionMode.groups()?.harness.rows.map((row) => row.option.id)).toContain("bypassPermissions")
    const draft = surface(nativeHarness("codex"))
    expect(draft.permissionMode.current()?.id, "a draft starts on the harness default").toBe("workspace-write")
    expect([...session.reads, ...draft.reads]).toEqual([])
    dispose()
  })
})

test("permission surface: Pi names Ask and Full access with no read, a draft starts on Full access, and a pick of Ask is what its prompt carries", () => {
  createRoot((dispose) => {
    const draft = surface(nativeHarness("pi"))
    expect(draft.permissionMode.groups()?.harness.rows.map((row) => [row.option.id, row.selectable])).toEqual([["ask", true], ["full", true]])
    expect(draft.permissionMode.current()?.id).toBe("full")
    const ask = draft.permissionMode.groups()!.harness.rows[0]!.option
    draft.permissionMode.select(ask)
    expect(draft.permissionMode.promptModeId()).toBe("ask")
    const session = surface(nativeHarness("pi"), { permissionMode: "ask" })
    expect(session.permissionMode.current()?.name).toBe("Ask")
    draft.permissionMode.openModes()
    expect([...draft.reads, ...session.reads]).toEqual([])
    dispose()
  })
})

test("permission surface: OpenCode shows as unavailable, and nothing is read for it", () => {
  createRoot((dispose) => {
    const { permissionMode, reads } = surface(nativeHarness("opencode"), {})
    expect(permissionMode.groups()?.harness).toMatchObject({ rows: [], unavailable: expect.any(String) })
    expect(permissionMode.groups()?.harness.loading).toBeUndefined()
    expect(permissionMode.current()).toBeUndefined()
    permissionMode.openModes()
    expect(reads).toEqual([])
    dispose()
  })
})

test("permission surface: an ACP agent's modes are read only once its chip opens", async () => {
  const { permissionMode, reads, dispose } = createRoot((dispose) => ({ ...surface(connectionHarness("scripted-acp"), {}), dispose }))
  expect(permissionMode.groups()?.harness.loading).toBe(true)
  expect(reads).toEqual([])
  permissionMode.openModes()
  await Promise.resolve()
  expect(reads).toEqual([{ placementId, ref }])
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(permissionMode.current()?.name).toBe("Default")
  dispose()
})

test("permission surface: an ACP chip names the row's mode by the agent's own name until it opens", async () => {
  const { permissionMode, reads, dispose } = createRoot((dispose) => ({
    ...surface(connectionHarness("scripted-acp"), { permissionMode: "default", permissionModeLabel: "Ask before edits" }),
    dispose,
  }))
  expect([permissionMode.current()?.id, permissionMode.current()?.name]).toEqual(["default", "Ask before edits"])
  expect(reads).toEqual([])
  permissionMode.openModes()
  await Promise.resolve()
  expect(reads).toEqual([{ placementId, ref }])
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(permissionMode.current()?.name).toBe("Default")
  dispose()
})
