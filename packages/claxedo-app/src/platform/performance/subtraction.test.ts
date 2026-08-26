import { describe, expect, test } from "bun:test"
import {
  CONTROL_SUBTRACTION_MANIFEST,
  SUBTRACTION_OWNERS,
  resolveSubtractionManifest,
} from "./subtraction"
import {
  instrumentOwnerExecution,
  instrumentOwnerMount,
  instrumentOwnerResource,
  type OwnerInstrumentationEvent,
  type OwnerInstrumentationTarget,
} from "./owner-instrumentation"

describe("diagnostic subtraction", () => {
  test("uses one deterministic owner variant at a time", () => {
    expect(SUBTRACTION_OWNERS.map((owner) => resolveSubtractionManifest({
      mode: "performance-diagnostic",
      owner,
    }))).toEqual([
      { schema: 1, diagnosticOnly: true, variant: "without-renderer", owner: "renderer" },
      { schema: 1, diagnosticOnly: true, variant: "without-host", owner: "host" },
      { schema: 1, diagnosticOnly: true, variant: "without-terminal", owner: "terminal" },
      { schema: 1, diagnosticOnly: true, variant: "without-app", owner: "app" },
    ])
  })

  test("keeps ordinary builds on the unchanged control and blocks leaks", () => {
    expect(resolveSubtractionManifest({ mode: "production" })).toBe(CONTROL_SUBTRACTION_MANIFEST)
    expect(() => resolveSubtractionManifest({ mode: "production", owner: "app" })).toThrow(
      "requires --mode performance-diagnostic",
    )
    expect(() => resolveSubtractionManifest({ mode: "performance-diagnostic", owner: "app,terminal" })).toThrow(
      "Unknown Claxedo subtraction owner",
    )
  })
})

describe("owner instrumentation", () => {
  test("records deterministic lifecycle, resource, and execution counts", () => {
    const events: OwnerInstrumentationEvent[] = []
    const target: OwnerInstrumentationTarget = {
      __CLAXEDO_OWNER_INSTRUMENTATION__: { record: (event) => events.push(event) },
    }
    let clock = 10
    const now = () => clock++
    const dispose = instrumentOwnerMount("terminal", "terminal:pty-1", { target, now })
    const release = instrumentOwnerResource("terminal", "backend:pty-1", { target, now })
    instrumentOwnerExecution("terminal", "write", { target, now })
    release()
    release()
    dispose()
    dispose()

    expect(events).toEqual([
      { schema: 1, sequence: 1, owner: "terminal", label: "terminal:pty-1", kind: "mount", activeInstances: 1, activeResources: 0, executionCount: 0, atMs: 10 },
      { schema: 1, sequence: 2, owner: "terminal", label: "backend:pty-1", kind: "resource-acquire", activeInstances: 1, activeResources: 1, executionCount: 0, atMs: 11 },
      { schema: 1, sequence: 3, owner: "terminal", label: "write", kind: "execution", activeInstances: 1, activeResources: 1, executionCount: 1, atMs: 12 },
      { schema: 1, sequence: 4, owner: "terminal", label: "backend:pty-1", kind: "resource-release", activeInstances: 1, activeResources: 0, executionCount: 1, atMs: 13 },
      { schema: 1, sequence: 5, owner: "terminal", label: "terminal:pty-1", kind: "dispose", activeInstances: 0, activeResources: 0, executionCount: 1, atMs: 14 },
    ])
  })

  test("extends the existing opt-in renderer trace surface", () => {
    const target: OwnerInstrumentationTarget = { __claxedoPerfTrace: true }
    const dispose = instrumentOwnerMount("renderer", "desktop-renderer", { target, now: () => 5 })
    dispose()
    expect(target.__claxedoPerfOwnerEvents?.map(({ sequence, owner, kind, activeInstances }) => ({
      sequence,
      owner,
      kind,
      activeInstances,
    }))).toEqual([
      { sequence: 1, owner: "renderer", kind: "mount", activeInstances: 1 },
      { sequence: 2, owner: "renderer", kind: "dispose", activeInstances: 0 },
    ])
  })

  test("is inert when no collector is installed", () => {
    let clockReads = 0
    const now = () => ++clockReads
    const target = {}
    const dispose = instrumentOwnerMount("app", "shell", { target, now })
    const release = instrumentOwnerResource("app", "listener", { target, now })
    instrumentOwnerExecution("app", "memo", { target, now })
    release()
    dispose()
    expect(clockReads).toBe(0)
  })
})
