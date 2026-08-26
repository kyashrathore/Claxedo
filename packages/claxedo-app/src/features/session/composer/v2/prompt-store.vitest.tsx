import { createEffect } from "solid-js"
// T2.1 (plan 2026-07-25-005): the raw per-scope draft tuple + scope identity that
// upstream's v2 prompt-input controller binds to.
//
// These exercise the REAL upstream consumer (`createPromptInputV2Store` from the
// vendored tree) against the REAL provider, and the real two-arg
// `createEffect(compute, apply, { defer: true })` shape the controller uses at
// `interaction.ts:77` — not a hand-rolled restatement of either.
import { afterEach, describe, expect, test, vi } from "vitest"
import { createTrackedEffect, createSignal } from "solid-js"
import { render, cleanup, waitFor } from "@solidjs/testing-library"
import { createPromptInputV2Store } from "@opencode-ai/session-ui/v2/prompt-input/store"
import { createPromptInputV2Controller } from "@opencode-ai/session-ui/v2/prompt-input/interaction"

const [sessionId, setSessionId] = createSignal<string | undefined>(undefined)

vi.mock("@/features/session/app-ports", () => ({
  useServer: () => ({ url: "http://localhost:4096" }),
}))

vi.mock("@/platform/persistence/persist", async () => {
  const { createStore } = await import("solid-js")
  return {
    Persist: {
      scoped: (...input: unknown[]) => JSON.stringify(input),
      serverScoped: (...input: unknown[]) => JSON.stringify(input),
    },
    persisted: (_key: string, initial: ReturnType<typeof createStore>) => [...initial, () => true, () => true] as const,
  }
})

import {
  promptDraftControllerInput,
  promptDraftStoreTuple,
  PromptProvider,
  usePrompt,
} from "@/features/session/providers/prompt"

let latest: ReturnType<typeof usePrompt>
let identityChanges = 0

function Probe() {
  latest = usePrompt()
  // Exactly the controller's reconcile trigger (`interaction.ts:77`).
  createEffect(
    () => latest.capture(),
    () => {
      identityChanges += 1
    },
    { defer: true },
  )
  return (
    <div data-testid="prompt">
      {latest
        .current()
        .map((part) => ("content" in part ? part.content : ""))
        .join("")}
    </div>
  )
}

function mount() {
  return render(() => (
    <PromptProvider directory="/repo" sessionId={sessionId}>
      <Probe />
    </PromptProvider>
  ))
}

afterEach(() => {
  cleanup()
  setSessionId(undefined)
  identityChanges = 0
})

describe("prompt draft store tuple (upstream v2 controller inputs)", () => {
  test("returns one reference-stable tuple per scope and a different one per other scope", async () => {
    setSessionId("stable-a")
    mount()

    const first = latest.capture()
    expect(latest.capture()).toBe(first)
    expect(promptDraftStoreTuple(first)).toBe(promptDraftStoreTuple(latest.capture()))

    // A draft edit must not mint a new tuple — the controller holds this
    // reference for the lifetime of the mount.
    latest.set([{ type: "text", content: "edited", start: 0, end: 6 }], 6)
    await waitFor(() => expect(latest.current()[0]).toMatchObject({ content: "edited" }))
    expect(latest.capture()).toBe(first)

    setSessionId("stable-b")
    await waitFor(() => expect(latest.capture()).not.toBe(first))
    const second = latest.capture()
    expect(promptDraftStoreTuple(second)).not.toBe(promptDraftStoreTuple(first))

    // ...and coming back resolves to the SAME entry, not a rebuilt one.
    setSessionId("stable-a")
    await waitFor(() => expect(latest.capture()).toBe(first))
  })

  test("identity changes on a scope switch and never on a draft edit", async () => {
    setSessionId("identity-a")
    mount()
    expect(identityChanges).toBe(0)

    latest.set([{ type: "text", content: "one", start: 0, end: 3 }], 3)
    latest.set([{ type: "text", content: "one two", start: 0, end: 7 }], 7)
    latest.reset()
    latest.context.add({ type: "file", path: "src/a.ts" })
    await waitFor(() => expect(latest.context.items().length).toBe(1))
    expect(identityChanges).toBe(0)

    setSessionId("identity-b")
    await waitFor(() => expect(identityChanges).toBe(1))

    latest.set([{ type: "text", content: "beta", start: 0, end: 4 }], 4)
    await waitFor(() => expect(latest.current()[0]).toMatchObject({ content: "beta" }))
    expect(identityChanges).toBe(1)

    setSessionId("identity-c")
    await waitFor(() => expect(identityChanges).toBe(2))
  })

  test("drives upstream's own store wrapper and keeps drafts scoped", async () => {
    setSessionId("wired-a")
    const view = mount()

    const bound = promptDraftControllerInput(() => latest.capture())
    const draft = createPromptInputV2Store(bound.store)

    draft.setText("from upstream store")
    await waitFor(() => expect(view.getByTestId("prompt").textContent).toBe("from upstream store"))
    expect(draft.state.cursor).toBe("from upstream store".length)
    expect(latest.cursor()).toBe("from upstream store".length)

    // Same binding, new scope: reads follow the accessor, so the other scope's
    // draft is empty rather than leaking the first one's text.
    setSessionId("wired-b")
    await waitFor(() => expect(view.getByTestId("prompt").textContent).toBe(""))
    expect(draft.state.prompt.map((part) => ("content" in part ? part.content : "")).join("")).toBe("")

    draft.addText("second scope")
    await waitFor(() => expect(view.getByTestId("prompt").textContent).toBe("second scope"))

    setSessionId("wired-a")
    await waitFor(() => expect(view.getByTestId("prompt").textContent).toBe("from upstream store"))
    expect(draft.state.prompt.map((part) => ("content" in part ? part.content : "")).join("")).toBe(
      "from upstream store",
    )

    // Context items round-trip through upstream's `addContext`/`removeContext`,
    // which require the `key` field our items already carry.
    draft.addContext({ type: "file", key: "file:src/b.ts", path: "src/b.ts" })
    await waitFor(() => expect(latest.context.items().map((item) => item.key)).toEqual(["file:src/b.ts"]))
    draft.removeContext("file:src/b.ts")
    await waitFor(() => expect(latest.context.items()).toEqual([]))
  })

  test("reconciles the real controller's machine back to initial state on a scope switch", async () => {
    setSessionId("machine-a")
    let controller: ReturnType<typeof createPromptInputV2Controller>

    function ControllerProbe() {
      latest = usePrompt()
      const bound = promptDraftControllerInput(() => latest.capture())
      controller = createPromptInputV2Controller({
        store: bound.store,
        identity: bound.identity,
        commands: () => [],
        context: () => [],
        searchContextFiles: () => [],
        view: {
          submit: { stopping: () => false, onSubmit: () => {}, onStop: () => {} },
        },
      })
      return <div data-testid="value">{controller.value()}</div>
    }

    const view = render(() => (
      <PromptProvider directory="/repo" sessionId={sessionId}>
        <ControllerProbe />
      </PromptProvider>
    ))

    // Opening the command palette on an empty draft moves the machine off its
    // initial state AND writes "/" through the tuple — so this one dispatch
    // proves both the write path and the non-initial machine state.
    controller!.dispatch({ type: "commands.open" })
    expect(controller!.state.popover.type).toBe("command-inline")
    expect(controller!.state.focus).toBe("editor")
    await waitFor(() => expect(view.getByTestId("value").textContent).toBe("/"))

    // A draft edit must NOT reconcile the machine.
    latest.set([{ type: "text", content: "abc", start: 0, end: 3 }], 3)
    await waitFor(() => expect(view.getByTestId("value").textContent).toBe("abc"))
    expect(controller!.state.popover.type).toBe("command-inline")

    setSessionId("machine-b")
    await waitFor(() => expect(controller!.state.popover.type).toBe("closed"))
    expect(controller!.state.focus).toBe("external")
    expect(controller!.state.mode).toBe("normal")
    expect(controller!.state.historyIndex).toBe(-1)
    // ...and the other scope's draft is not leaked into the new one.
    expect(controller!.value()).toBe("")

    setSessionId("machine-a")
    await waitFor(() => expect(controller!.value()).toBe("abc"))
  })

  test("does not evict a live scope while the LRU is under its cap", async () => {
    setSessionId("live-scope")
    mount()
    const live = latest.capture()

    for (let index = 0; index < 6; index++) {
      setSessionId(`neighbour-${index}`)
      await waitFor(() => expect(latest.capture()).not.toBe(live))
    }

    setSessionId("live-scope")
    await waitFor(() => expect(latest.capture()).toBe(live))
  })

  // Characterisation, not aspiration: `createLruResourceCache` does NOT
  // ref-count (unlike `createRefCountedResourceCache` in the same module), so a
  // mounted controller's scope IS evictable once 20 other scopes are loaded
  // after it. Recorded so the lifetime risk is visible rather than latent.
  test("DOES evict a live scope once MAX_PROMPT_SESSIONS other scopes load after it", async () => {
    setSessionId("victim-scope")
    mount()
    const victim = latest.capture()

    for (let index = 0; index < 20; index++) {
      setSessionId(`evictor-${index}`)
      await waitFor(() => expect(latest.capture()).not.toBe(victim))
    }

    setSessionId("victim-scope")
    await waitFor(() => expect(latest.capture()).not.toBe(victim))
  })
})
