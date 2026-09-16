import { describe, expect, test } from "vitest"
import { createComputed, createRoot, createSignal } from "solid-js"
import {
  commandOwnerActive,
  createCommandPresence,
  createCoalescedMicrotask,
  formatKeybind,
  indexCommandOptions,
  projectCommandRegistrations,
  resolveEffectiveKeybind,
  upsertCommandRegistration,
  type CommandRegistration,
} from "./command-palette"

describe("resolveEffectiveKeybind", () => {
  test("custom rebind wins over the registered default", () => {
    expect(resolveEffectiveKeybind("mod+k", "mod+p")).toBe("mod+k")
  })

  test("falls back to the registered default when there is no override", () => {
    expect(resolveEffectiveKeybind(undefined, "mod+p")).toBe("mod+p")
  })

  test("the 'none' sentinel unbinds the command (palette shows nothing)", () => {
    expect(resolveEffectiveKeybind("none", "mod+p")).toBeUndefined()
  })

  test("an empty override unbinds rather than silently reverting to the default", () => {
    expect(resolveEffectiveKeybind("", "mod+p")).toBeUndefined()
  })

  test("an undefined default with no override yields no binding", () => {
    expect(resolveEffectiveKeybind(undefined, undefined)).toBeUndefined()
  })
})

describe("narrow command projections", () => {
  test("indexes a large catalog once for repeated exact keybind lookups", () => {
    let idReads = 0
    const options = Array.from({ length: 2_000 }, (_, index) => ({
      get id() {
        idReads++
        return `extension.${index}`
      },
      title: `Extension ${index}`,
      keybind: `mod+${index}`,
    }))
    const index = indexCommandOptions(options)
    const readsAfterIndex = idReads

    for (let iteration = 0; iteration < 1_000; iteration++) {
      expect(index.get("extension.1999")?.keybind).toBe("mod+1999")
    }

    expect(idReads).toBe(readsAfterIndex)
  })

  test("coalesces a synchronous registration burst into one latest projection", async () => {
    let topology = 0
    const projected: number[] = []
    const task = createCoalescedMicrotask(() => projected.push(topology))

    for (let index = 1; index <= 1_000; index++) {
      topology = index
      task.schedule()
    }
    expect(projected).toEqual([])

    await Promise.resolve()
    expect(projected).toEqual([1_000])
    task.dispose()
  })

  test("a large palette exposes only slash-capable commands to the composer", () => {
    let irrelevantDisabledReads = 0
    const irrelevant = Array.from({ length: 2_000 }, (_, index) => ({
      id: `extension.${index}`,
      title: `Extension ${index}`,
      get disabled() {
        irrelevantDisabledReads++
        return false
      },
    }))
    const slash = { id: "session.compact", title: "Compact", slash: "compact" }
    const projection = projectCommandRegistrations([{ options: () => [...irrelevant, slash] }])

    expect(projection.all).toHaveLength(2_001)
    expect(projection.slash).toEqual([slash])
    // Checking slash first means unrelated palette entries do not pay reads of
    // slash-only state as the cold session composer mounts.
    expect(irrelevantDisabledReads).toBe(0)
  })

  test("exact command presence ignores unrelated catalog topology changes", () => {
    createRoot((dispose) => {
      const [ids, setIds] = createSignal<ReadonlySet<string>>(new Set(["project.open"]))
      const has = createCommandPresence(ids)
      let runs = 0
      createComputed(() => {
        has("project.open")
        runs++
      })

      expect(runs).toBe(1)
      setIds(new Set(["project.open", "extension.new"]))
      expect(runs).toBe(1)
      setIds(new Set(["extension.new"]))
      expect(runs).toBe(2)
      dispose()
    })
  })
})

describe("formatKeybind", () => {
  test("formats a default binding and an effective override", () => {
    const original = formatKeybind(resolveEffectiveKeybind(undefined, "mod+shift+p") ?? "")
    const rebound = formatKeybind(resolveEffectiveKeybind("mod+k", "mod+shift+p") ?? "")
    expect(original).toContain("P")
    expect(rebound).toContain("K")
    expect(rebound).not.toContain("P")
    expect(formatKeybind(resolveEffectiveKeybind("none", "mod+shift+p") ?? "")).toBe("")
  })
})

describe("command ownership", () => {
  const owner = (state: { visible: boolean; focused: boolean }) => ({
    isVisible: () => state.visible,
    isFocused: () => state.focused,
  })

  test("two panes may each hold the same keyed registration", () => {
    const a: CommandRegistration = { key: "session", owner: owner({ visible: true, focused: true }), options: () => [] }
    const b: CommandRegistration = { key: "session", owner: owner({ visible: true, focused: false }), options: () => [] }
    const both = upsertCommandRegistration(upsertCommandRegistration([], a), b)
    expect(both).toEqual([b, a])

    const replaced = upsertCommandRegistration(both, { ...a })
    expect(replaced).toHaveLength(2)
    expect(replaced.some((entry) => entry === a)).toBe(false)
  })

  test("a registration without an owner replaces its key as before", () => {
    const first: CommandRegistration = { key: "workspace", options: () => [] }
    const second: CommandRegistration = { key: "workspace", options: () => [] }
    expect(upsertCommandRegistration([first], second)).toEqual([second])
  })

  test("only the shown surface of the focused pane serves; a hidden retained tab in that pane does not", () => {
    expect(commandOwnerActive(undefined)).toBe(true)
    expect(commandOwnerActive(owner({ visible: true, focused: true }))).toBe(true)
    expect(commandOwnerActive(owner({ visible: true, focused: false }))).toBe(false)
    expect(commandOwnerActive(owner({ visible: false, focused: true }))).toBe(false)
  })
})
