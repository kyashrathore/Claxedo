import { describe, expect, test } from "bun:test"
import {
  createModelSelectionController,
  createModelSelectionPicker,
  modelKeyFromPickerItem,
  modelKeyFromPickerSelection,
  setModelSelection,
  type ModelSelectionCommand,
} from "./model-selection"

describe("model-selection command", () => {
  test("normalizes picker selections into ModelKey", () => {
    expect(modelKeyFromPickerSelection({ providerID: "claude-acp", modelID: "sonnet" })).toEqual({
      providerID: "claude-acp",
      modelID: "sonnet",
    })
    expect(modelKeyFromPickerSelection(undefined)).toBeUndefined()
    expect(modelKeyFromPickerSelection({ providerID: "claude-acp" })).toBeUndefined()
    expect(modelKeyFromPickerSelection({ providerID: "", modelID: "sonnet" })).toBeUndefined()
    expect(modelKeyFromPickerSelection({ providerID: "claude-acp", modelID: "" })).toBeUndefined()
    expect(modelKeyFromPickerItem({ id: "opus", provider: { id: "claude-acp" } })).toEqual({
      providerID: "claude-acp",
      modelID: "opus",
    })
  })

  test("routes ui and agent selections through the same writer contract", async () => {
    const writes: ModelSelectionCommand[] = []
    const writer = {
      write: (command: ModelSelectionCommand) => {
        writes.push(command)
      },
    }

    await setModelSelection(writer, {
      scope: { key: "scope-a" },
      source: "ui",
      model: { providerID: "opencode", modelID: "big-pickle" },
      recent: true,
    })
    await setModelSelection(writer, {
      scope: { key: "scope-b" },
      source: "agent",
      model: { providerID: "opencode", modelID: "big-pickle" },
    })

    expect(writes.map((item) => item.source)).toEqual(["ui", "agent"])
    expect(writes.map((item) => item.model)).toEqual([
      { providerID: "opencode", modelID: "big-pickle" },
      { providerID: "opencode", modelID: "big-pickle" },
    ])
  })

  test("skips writes when the requested model is already current", async () => {
    const writes: ModelSelectionCommand[] = []

    const result = await setModelSelection({
      write: (command) => {
        writes.push(command)
      },
    }, {
      scope: {
        key: "scope-a",
        current: () => ({ providerID: "opencode", modelID: "big-pickle" }),
      },
      source: "ui",
      model: { providerID: "opencode", modelID: "big-pickle" },
    })

    expect(result).toEqual({
      changed: false,
      model: { providerID: "opencode", modelID: "big-pickle" },
      source: "ui",
      reason: "unchanged",
    })
    expect(writes).toEqual([])
  })

  test("dedupes one config sync per distinct in-flight selection", async () => {
    const writes: ModelSelectionCommand[] = []
    const syncs: ModelSelectionCommand[] = []
    let release: (() => void) | undefined
    const blocker = new Promise<void>((resolve) => {
      release = resolve
    })

    const writer = {
      write: async (command: ModelSelectionCommand) => {
        writes.push(command)
        await blocker
      },
      sync: (command: ModelSelectionCommand) => {
        syncs.push(command)
      },
    }

    const controller = createModelSelectionController(writer)
    const first = controller.set({
      scope: { key: "scope-a" },
      source: "ui",
      model: { providerID: "claude-acp", modelID: "sonnet" },
    })
    const second = controller.set({
      scope: { key: "scope-a" },
      source: "agent",
      model: { providerID: "claude-acp", modelID: "sonnet" },
    })

    expect(writes).toHaveLength(1)
    release?.()
    await expect(first).resolves.toEqual({
      changed: true,
      model: { providerID: "claude-acp", modelID: "sonnet" },
      source: "ui",
    })
    await expect(second).resolves.toEqual({
      changed: false,
      model: { providerID: "claude-acp", modelID: "sonnet" },
      source: "agent",
      reason: "pending",
    })
    expect(syncs).toHaveLength(1)

    await setModelSelection(writer, {
      scope: { key: "scope-a" },
      source: "ui",
      model: { providerID: "claude-acp", modelID: "opus" },
    })
    expect(writes.map((item) => item.model?.modelID)).toEqual(["sonnet", "opus"])
    expect(syncs.map((item) => item.model?.modelID)).toEqual(["sonnet", "opus"])
  })

  test("picker adapter routes UI writes through the model selection command", () => {
    const writes: ModelSelectionCommand[] = []
    const picker = createModelSelectionPicker({
      list: () => [{ id: "sonnet", provider: { id: "claude-acp" }, name: "Sonnet" }],
      current: () => ({ id: "sonnet", provider: { id: "claude-acp" }, name: "Sonnet" }),
      visible: () => true,
      scope: () => ({
        key: "session:session-1",
        current: () => ({ providerID: "claude-acp", modelID: "sonnet" }),
      }),
      write: (model, options) => {
        writes.push({
          scope: { key: "session:session-1" },
          source: "ui",
          model,
          recent: options?.recent,
        })
      },
    })

    expect(picker.list().map(modelKeyFromPickerItem)).toEqual([{ providerID: "claude-acp", modelID: "sonnet" }])
    picker.set({ providerID: "claude-acp", modelID: "opus" }, { recent: true })

    expect(writes).toEqual([{
      scope: { key: "session:session-1" },
      source: "ui",
      model: { providerID: "claude-acp", modelID: "opus" },
      recent: true,
    }])
  })
})
