import { afterEach, describe, expect, test } from "vitest"
import { cleanup, render } from "@solidjs/testing-library"
import { createEffect, createRoot, createSignal, flush } from "solid-js"
import {
  createCommandPresence,
  createCoalescedMicrotask,
  formatKeybind,
  indexCommandOptions,
  projectCommandRegistrations,
  resolveEffectiveKeybind,
} from "./command-palette"

afterEach(cleanup)

// The command palette's discoverability contract (WP-C2): each command entry
// lists the ACTIVE keybinding next to it, where "active" means the user's custom
// rebind wins over the registered default and the "none" sentinel hides the
// binding. `select-file.tsx` renders exactly `formatKeybind(option.keybind)`
// where `option.keybind` is the effective binding produced by
// `resolveEffectiveKeybind`. These tests exercise that same composition.

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
    // Solid 2 rejects reactive writes made from inside an owned scope, so the
    // catalog signal and its writes live outside the root; the presence graph
    // under test is the only thing the root owns.
    const [ids, setIds] = createSignal<ReadonlySet<string>>(new Set(["project.open"]))
    let runs = 0
    const dispose = createRoot((disposeRoot) => {
      const has = createCommandPresence(ids)
      createEffect(
        () => {
          has("project.open")
          runs++
        },
        () => {},
      )
      return disposeRoot
    })

    expect(runs).toBe(1)
    setIds(new Set(["project.open", "extension.new"]))
    flush()
    expect(runs).toBe(1)
    setIds(new Set(["extension.new"]))
    flush()
    expect(runs).toBe(2)
    dispose()
  })
})

// Mirrors select-file.tsx's keybind cell: <Keybind>{formatKeybind(effective)}</Keybind>
function KeybindCell(props: { custom?: string; registeredDefault?: string }) {
  const effective = () => resolveEffectiveKeybind(props.custom, props.registeredDefault)
  return <span data-testid="keybind">{formatKeybind(effective() ?? "")}</span>
}

describe("command palette keybind cell", () => {
  test("renders the registered default binding next to a command", () => {
    const { getByTestId } = render(() => <KeybindCell registeredDefault="mod+shift+p" />)
    const text = getByTestId("keybind").textContent ?? ""
    // Platform-dependent modifier glyphs, but the command key is always shown.
    expect(text).toContain("P")
    expect(text.length).toBeGreaterThan(1)
  })

  test("renders the user's active rebind, not the default", () => {
    const { getByTestId } = render(() => <KeybindCell custom="mod+k" registeredDefault="mod+shift+p" />)
    const text = getByTestId("keybind").textContent ?? ""
    expect(text).toContain("K")
    expect(text).not.toContain("P")
  })

  test("renders an empty cell when the command is unbound", () => {
    const { getByTestId } = render(() => <KeybindCell custom="none" registeredDefault="mod+shift+p" />)
    expect(getByTestId("keybind").textContent).toBe("")
  })
})
