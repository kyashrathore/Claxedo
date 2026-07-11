import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { queryClient } from "../../shared/query/query-client"
import { shellDataKeys } from "../data/keys"
import {
  clearLocalSelectionHandoff,
  getLocalSelectionHandoff,
  localDraftSelectionHandoffID,
  localSelectionHandoffQueryKey,
  resetLocalSelectionHandoffForTest,
  setLocalSelectionHandoff,
} from "./local-selection-handoff"

const root = path.resolve(import.meta.dir, "../..")

describe("local selection handoff", () => {
  afterEach(() => {
    resetLocalSelectionHandoffForTest()
  })

  test("stores provider/model handoff under a session-scoped query key", () => {
    const key = localSelectionHandoffQueryKey("ses_1")

    expect(key).toEqual(shellDataKeys.sessionId("ses_1", "local-selection-handoff"))

    setLocalSelectionHandoff("ses_1", {
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-sonnet", variant: "fast" },
      variant: "fast",
    })

    expect(queryClient.getQueryData(key)).toEqual({
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-sonnet", variant: "fast" },
      variant: "fast",
    })
    expect(getLocalSelectionHandoff("ses_1")).toEqual({
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-sonnet", variant: "fast" },
      variant: "fast",
    })
  })

  test("clears only the selected session handoff", () => {
    setLocalSelectionHandoff("ses_1", { agent: "build" })
    setLocalSelectionHandoff("ses_2", { agent: "plan" })

    clearLocalSelectionHandoff("ses_1")

    expect(getLocalSelectionHandoff("ses_1")).toBeUndefined()
    expect(getLocalSelectionHandoff("ses_2")).toEqual({ agent: "plan" })
  })

  test("draft handoff reuses the session-scoped handoff key with a deterministic draft id", () => {
    const id = localDraftSelectionHandoffID("/repo/main")
    const key = localSelectionHandoffQueryKey(id)

    expect(id).toBe("__claxedo_draft__:/repo/main")
    expect(key).toEqual(shellDataKeys.sessionId("__claxedo_draft__:/repo/main", "local-selection-handoff"))

    setLocalSelectionHandoff(id, {
      agent: "build",
      model: { providerID: "opencode", modelID: "deepseek-v4-flash-free" },
      variant: null,
    })

    expect(getLocalSelectionHandoff(id)).toEqual({
      agent: "build",
      model: { providerID: "opencode", modelID: "deepseek-v4-flash-free" },
      variant: null,
    })

    clearLocalSelectionHandoff(id)

    expect(queryClient.getQueryData(key)).toBeUndefined()
  })

  test("clones values so provider/model state is not mutated through the cache", () => {
    const state = {
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-sonnet" },
    }

    setLocalSelectionHandoff("ses_1", state)
    state.model.modelID = "mutated"
    const cached = getLocalSelectionHandoff("ses_1")
    if (cached?.model) cached.model.modelID = "also-mutated"

    expect(getLocalSelectionHandoff("ses_1")?.model?.modelID).toBe("claude-sonnet")
  })

  test("local providers do not own provider/model handoff in private maps", async () => {
    const claxedoLocal = await Bun.file(path.join(root, "context/session-selection.tsx")).text()

    expect(await Bun.file(path.join(root, "overrides/context/session-selection.tsx")).exists()).toBe(false)
    expect(claxedoLocal).toMatch(/localSelectionHandoffQueryKey/)
    expect(claxedoLocal).toMatch(/setLocalSelectionHandoff/)
    expect(claxedoLocal).not.toMatch(/const handoff = new Map/)
    expect(claxedoLocal).not.toMatch(/handoff\.set/)
    expect(claxedoLocal).not.toMatch(/handoff\.get/)
    expect(claxedoLocal).not.toMatch(/handoff\.has/)
  })
})
