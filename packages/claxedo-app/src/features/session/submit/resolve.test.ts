import { describe, expect, test } from "bun:test"
import {
  resolveSubmitDirectory,
  resolveSubmitMode,
  resolveSubmitSessionTarget,
  resolveSubmittedConfig,
} from "./resolve"
import type { SubmitSessionGetClient, SubmitSessionTarget } from "./types"

// Rubric T2: per-phase test for resolve.ts. Each helper is pure given its
// injected dependencies, so the tests exercise the decision tree rather than
// any side effects.

describe("resolveSubmitMode", () => {
  test("normalizes a persisted shell choice before runtime submission", () => {
    const seen: string[] = []
    expect(resolveSubmitMode({ mode: "shell", setMode: (mode) => seen.push(mode) })).toBe("normal")
    expect(seen).toEqual(["normal"])
  })
  test("keeps normal mode without notifying the composer", () => {
    expect(resolveSubmitMode({ mode: "normal", setMode: () => { throw new Error("unexpected update") } })).toBe("normal")
  })
})

describe("resolveSubmittedConfig", () => {
  test("requires the authoritative model key", async () => {
    expect(await resolveSubmittedConfig({ currentAgent: { name: "ask" } })).toBeUndefined()
  })
  test("uses the exact selected key and variant", async () => {
    expect(await resolveSubmittedConfig({ harnessModelKey: { providerID: "connection", modelID: "sonnet", variant: "high" }, currentAgent: { name: "ask" } })).toEqual({ model: { providerID: "connection", modelID: "sonnet" }, agent: "ask", variant: "high" })
  })
  test("agent override wins and an explicit variant overrides the key", async () => {
    expect(await resolveSubmittedConfig({ harnessModelKey: { providerID: "pi", modelID: "sonnet", variant: "high" }, currentAgent: { name: "build" }, agentOverride: "ask", variant: "low" })).toEqual({ model: { providerID: "pi", modelID: "sonnet" }, agent: "ask", variant: "low" })
  })
  test("uses a real default agent, then build when no agent is selected", async () => {
    const base = { harnessModelKey: { providerID: "pi", modelID: "sonnet" }, currentAgent: { name: "default" } }
    expect((await resolveSubmittedConfig({ ...base, defaultAgent: { name: "general" } }))?.agent).toBe("general")
    expect((await resolveSubmittedConfig(base))?.agent).toBe("build")
  })
  test("submits the catalog agent id rather than its display name", async () => {
    const modelKey = { providerID: "pi", modelID: "sonnet" }
    const resolved = await resolveSubmittedConfig({
      harnessModelKey: modelKey,
      currentAgent: { name: "Build", id: "build" },
    })
    expect(resolved?.agent).toBe("build")
    const fallback = await resolveSubmittedConfig({
      harnessModelKey: modelKey,
      currentAgent: { name: "default" },
      defaultAgent: { name: "Build", id: "build" },
    })
    expect(fallback?.agent).toBe("build")
  })
})

describe("resolveSubmitDirectory", () => {
  const baseInput = {
    isNewSession: false,
    defaultDirectory: "/default",
    worktreeSelection: "main",
    workspaceKind: "local",
    showMissingWorkspace: () => undefined,
    resolveCloudSessionDirectory: async () => undefined,
    prepareCloudSessionDirectory: async () => true,
    createLocalWorktree: async () => undefined,
    publishCloudHandoff: () => undefined,
  } as const

  test("returns project/fallback/default in priority for existing sessions", async () => {
    expect(await resolveSubmitDirectory({ ...baseInput, projectDirectory: "/proj" })).toEqual({
      directory: "/proj",
    })
    expect(await resolveSubmitDirectory({ ...baseInput, fallbackDirectory: "/fall" })).toEqual({
      directory: "/fall",
    })
    expect(await resolveSubmitDirectory({ ...baseInput })).toEqual({ directory: "/default" })
  })

  test("draft without project + main worktree shows missing workspace and returns undefined", async () => {
    let shown = 0
    const result = await resolveSubmitDirectory({
      ...baseInput,
      isNewSession: true,
      draftId: "draft-1",
      worktreeSelection: "main",
      showMissingWorkspace: () => {
        shown++
      },
    })
    expect(shown).toBe(1)
    expect(result).toBeUndefined()
  })

  test("cloud path defers to resolveCloudSessionDirectory + prepareCloudSessionDirectory", async () => {
    let prepared = ""
    let handoff = ""
    const result = await resolveSubmitDirectory({
      ...baseInput,
      isNewSession: true,
      workspaceKind: "cloud",
      resolveCloudSessionDirectory: async () => "/cloud/ws",
      prepareCloudSessionDirectory: async (dir) => {
        prepared = dir
        return true
      },
      publishCloudHandoff: (_status, msg) => {
        handoff = msg
      },
    })
    expect(prepared).toBe("/cloud/ws")
    expect(handoff).toContain("Runtime ready")
    expect(result).toEqual({ directory: "/cloud/ws" })
  })

  test("cloud prepare failure short-circuits to undefined", async () => {
    const result = await resolveSubmitDirectory({
      ...baseInput,
      isNewSession: true,
      workspaceKind: "cloud",
      resolveCloudSessionDirectory: async () => "/cloud/ws",
      prepareCloudSessionDirectory: async () => false,
    })
    expect(result).toBeUndefined()
  })

  test("create worktree path delegates to createLocalWorktree", async () => {
    const result = await resolveSubmitDirectory({
      ...baseInput,
      isNewSession: true,
      worktreeSelection: "create",
      projectDirectory: "/proj",
      createLocalWorktree: async (dir) => `${dir}/feature`,
    })
    expect(result).toEqual({ directory: "/proj/feature" })
  })

  test("explicit worktree path uses the selection verbatim", async () => {
    const result = await resolveSubmitDirectory({
      ...baseInput,
      isNewSession: true,
      worktreeSelection: "/explicit/wt",
    })
    expect(result).toEqual({ directory: "/explicit/wt" })
  })
})

describe("resolveSubmitDirectory pending preparation", () => {
  const baseInput = {
    isNewSession: true,
    defaultDirectory: "/default",
    worktreeSelection: "main",
    workspaceKind: "cloud",
    showMissingWorkspace: () => undefined,
    createLocalWorktree: async () => undefined,
  } as const

  test("a pending cloud preparation failure suppresses the ready handoff", async () => {
    let signalStarted!: () => void
    let release!: (ready: boolean) => void
    const started = new Promise<void>((resolve) => { signalStarted = resolve })
    const handoffMessages: string[] = []
    const pending = resolveSubmitDirectory({
      ...baseInput,
      resolveCloudSessionDirectory: async () => "/cloud/ws",
      prepareCloudSessionDirectory: () => {
        signalStarted()
        return new Promise<boolean>((resolve) => { release = resolve })
      },
      publishCloudHandoff: (_status, message) => { handoffMessages.push(message) },
    })
    await started
    expect(handoffMessages).toEqual([])
    release(false)
    await expect(pending).resolves.toBeUndefined()
    expect(handoffMessages).toEqual([])
  })
})

describe("resolveSubmitSessionTarget", () => {
  const sessionClient = (id: string): SubmitSessionGetClient => ({
    session: {
      get: async () => ({ data: { id } }),
    },
  })
  const missingClient: SubmitSessionGetClient = {
    session: {
      get: async () => ({}),
    },
  }

  test("hands back the provided session unchanged when one exists", async () => {
    const session: SubmitSessionTarget = { id: "ses_a" }
    const result = await resolveSubmitSessionTarget({
      session,
      isNewSession: false,
      replaceSession: false,
      sessionDirectory: "/repo/main",
      sessionClient: () => sessionClient("ses_a"),
      createSessionTarget: async () => undefined,
    })
    expect(result).toEqual({ session, replaceSession: false, created: false })
    expect(result.session).toBe(session)
  })

  test("hydrates an existing session via client.get when explicitSessionID is given", async () => {
    const result = await resolveSubmitSessionTarget({
      explicitSessionID: "ses_x",
      isNewSession: false,
      replaceSession: false,
      sessionDirectory: "/repo/main",
      sessionClient: () => sessionClient("ses_x"),
      createSessionTarget: async () => undefined,
    })
    expect(result.session?.id).toBe("ses_x")
    expect(result.created).toBe(false)
  })

  test("preserves the explicitly selected session when the remote read has no projection", async () => {
    const result = await resolveSubmitSessionTarget({
      explicitSessionID: "ses_acp",
      isNewSession: false,
      replaceSession: false,
      sessionDirectory: "/repo/main",
      sessionClient: () => missingClient,
      createSessionTarget: async () => undefined,
    })
    expect(result.session?.id).toBe("ses_acp")
  })

  test("session target creation is delegated when replaceSession is true", async () => {
    let createCalls = 0
    const result = await resolveSubmitSessionTarget({
      isNewSession: true,
      replaceSession: true,
      sessionDirectory: "/repo/main",
      sessionClient: () => missingClient,
      createSessionTarget: async () => {
        createCalls++
        return { id: "ses_acp_claim" }
      },
    })
    expect(createCalls).toBe(1)
    expect(result.session?.id).toBe("ses_acp_claim")
    expect(result.created).toBe(true)
  })
})
