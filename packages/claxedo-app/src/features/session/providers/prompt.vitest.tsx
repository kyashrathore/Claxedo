import { afterEach, describe, expect, test, vi } from "vitest"
import { createSignal, flush } from "solid-js"
import { render, cleanup, waitFor } from "@solidjs/testing-library"

const [sessionId, setSessionId] = createSignal<string | undefined>(undefined)
const [draftId, setDraftId] = createSignal<string | undefined>(undefined)

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
    persisted: (_key: string, initial: ReturnType<typeof createStore>) => [...initial, () => true] as const,
  }
})

import {
  MAX_PROMPT_SESSIONS,
  PromptProvider,
  usePrompt,
  type ImageAttachmentPart,
} from "@/features/session/providers/prompt"

const [otherSessionId, setOtherSessionId] = createSignal<string | undefined>(undefined)

function text(value: string) {
  return [{ type: "text" as const, content: value, start: 0, end: value.length }]
}

let latest: ReturnType<typeof usePrompt>
let other: ReturnType<typeof usePrompt>

function Probe() {
  latest = usePrompt()
  return (
    <div data-testid="prompt" data-images={latest.current().filter((part) => part.type === "image").length}>
      {latest
        .current()
        .map((part) => ("content" in part ? part.content : ""))
        .join("")}
    </div>
  )
}

function OtherProbe() {
  other = usePrompt()
  return (
    <div data-testid="other">
      {other
        .current()
        .map((part) => ("content" in part ? part.content : ""))
        .join("")}
    </div>
  )
}

/**
 * Push `count` fresh entries into the process-global prompt cache through the
 * REAL scoped-write path (`DialogFork` restoring a forked draft, the post-submit
 * clear): each `set` with an explicit scope resolves — and therefore admits — one
 * more cache entry for a scope nothing has mounted.
 */
function pressureScopes(prompt: ReturnType<typeof usePrompt>, dir: string, count: number) {
  for (let index = 0; index < count; index++) {
    prompt.set(text(`pressure-${index}`), 0, { dir, id: `pressure-${index}` })
  }
}

afterEach(() => {
  cleanup()
  setSessionId(undefined)
  setDraftId(undefined)
  setOtherSessionId(undefined)
})

describe("PromptProvider", () => {
  test("keeps image attachments and submit cleanup isolated between new-session draft surfaces", async () => {
    setSessionId("new")
    setDraftId("draft-a")
    const view = render(() => (
      <PromptProvider directory="/repo" sessionId={sessionId} draftId={draftId}>
        <Probe />
      </PromptProvider>
    ))
    const attachment: ImageAttachmentPart = {
      type: "image",
      id: "image-a",
      filename: "screenshot.png",
      mime: "image/png",
      dataUrl: "data:image/png;base64,AAAA",
    }

    latest.set([...text("sent"), attachment], 4)
    await waitFor(() => expect(view.getByTestId("prompt")).toHaveAttribute("data-images", "1"))

    setDraftId("draft-b")
    await waitFor(() => expect(view.getByTestId("prompt")).toHaveAttribute("data-images", "0"))
    latest.set(text("fresh draft"), 11)
    await waitFor(() => expect(view.getByTestId("prompt").textContent).toBe("fresh draft"))

    latest.reset({ dir: "/repo", id: "new", draftId: "draft-a" })
    await waitFor(() => expect(view.getByTestId("prompt").textContent).toBe("fresh draft"))

    setDraftId("draft-a")
    await waitFor(() => {
      expect(view.getByTestId("prompt").textContent).toBe("")
      expect(view.getByTestId("prompt")).toHaveAttribute("data-images", "0")
    })
  })

  test("keeps drafts isolated per split session and honors scoped set/reset", async () => {
    setSessionId("ses-a")
    const view = render(() => (
      <PromptProvider directory="/repo" sessionId={sessionId}>
        <Probe />
      </PromptProvider>
    ))

    latest.set(text("alpha"), 5)
    await waitFor(() => expect(view.getByTestId("prompt").textContent).toBe("alpha"))

    setSessionId("ses-b")
    await waitFor(() => expect(view.getByTestId("prompt").textContent).toBe(""))

    latest.set(text("beta"), 4)
    await waitFor(() => expect(view.getByTestId("prompt").textContent).toBe("beta"))

    latest.set(text("gamma"), 5, { dir: "/repo", id: "ses-c" })
    latest.reset({ dir: "/repo", id: "ses-c" })

    setSessionId("ses-a")
    await waitFor(() => expect(view.getByTestId("prompt").textContent).toBe("alpha"))

    setSessionId("ses-b")
    await waitFor(() => expect(view.getByTestId("prompt").textContent).toBe("beta"))
  })

  // Defect 2. LIVENESS, not presence: `session()` is memoized on the provider's
  // props, so after an eviction it keeps handing out the SAME PromptSession
  // object whose reactive root was disposed underneath it. The object is still
  // there; its memos have been unsubscribed from the store. So the assertion has
  // to be that a write still propagates, which is the user-visible symptom
  // (composer stops rendering what the user types).
  test("keeps a mounted scope reactive when scoped writes push past the cache cap", async () => {
    setSessionId("live-a")
    const view = render(() => (
      <PromptProvider directory="/pressure-repo" sessionId={sessionId}>
        <Probe />
      </PromptProvider>
    ))

    latest.set(text("alpha"), 5)
    await waitFor(() => expect(view.getByTestId("prompt").textContent).toBe("alpha"))
    expect(latest.dirty()).toBe(true)

    const captured = latest.capture()
    pressureScopes(latest, "/pressure-repo", MAX_PROMPT_SESSIONS + 2)

    // Identity is deliberately checked too, to show it is NOT the discriminator:
    // it holds both before and after the fix.
    expect(latest.capture()).toBe(captured)

    latest.set(text("beta"), 4)
    await waitFor(() => expect(view.getByTestId("prompt").textContent).toBe("beta"))
    expect(
      latest
        .current()
        .map((part) => ("content" in part ? part.content : ""))
        .join(""),
    ).toBe("beta")
    expect(latest.dirty()).toBe(true)
  })

  // Defect 2, the multi-pane shape the cap actually makes plausible: pane B walks
  // through sessions while pane A sits still. Pane A never re-resolves, so under a
  // pure LRU its root is disposed out from under a component that is on screen.
  test("one pane's session churn does not disturb the other pane's mounted scope", async () => {
    setSessionId("pane-a")
    setOtherSessionId("pane-b-0")
    const view = render(() => (
      <>
        <PromptProvider directory="/pane-repo" sessionId={sessionId}>
          <Probe />
        </PromptProvider>
        <PromptProvider directory="/pane-repo" sessionId={otherSessionId}>
          <OtherProbe />
        </PromptProvider>
      </>
    ))

    latest.set(text("kept"), 4)
    await waitFor(() => expect(view.getByTestId("prompt").textContent).toBe("kept"))

    for (let index = 1; index <= MAX_PROMPT_SESSIONS + 2; index++) {
      setOtherSessionId(`pane-b-${index}`)
      // Switching the pane's session and then editing its draft are two
      // separate user actions; Solid 2 stages the switch until the scheduler
      // flushes, so without this `other` still points at the previous scope.
      flush()
      other.set(text(`b${index}`), 0)
      await waitFor(() => expect(view.getByTestId("other").textContent).toBe(`b${index}`))
    }

    latest.set(text("kept-live"), 9)
    await waitFor(() => expect(view.getByTestId("prompt").textContent).toBe("kept-live"))
  })

  // The other half of the ref-counting contract, and the one that turns a fix into
  // a leak if it is missing: an UNMOUNTED scope must lose its pin and become
  // collectable, so the cap still bounds memory. Observable without exporting the
  // cache — a collected entry means the next mount of that scope starts from a
  // fresh store, so the old draft is gone.
  test("collects a scope once it is unmounted, so the cap still bounds the cache", async () => {
    setSessionId("collectable")
    const first = render(() => (
      <PromptProvider directory="/collect-repo" sessionId={sessionId}>
        <Probe />
      </PromptProvider>
    ))

    latest.set(text("dropme"), 6)
    await waitFor(() => expect(first.getByTestId("prompt").textContent).toBe("dropme"))
    cleanup()

    const pressure = render(() => (
      <PromptProvider directory="/collect-pressure" sessionId={() => "pressure-host"}>
        <Probe />
      </PromptProvider>
    ))
    // Overshoot far enough that every entry admitted before this loop — including
    // the just-unmounted one — is past the cap regardless of what earlier tests
    // in this file left behind.
    pressureScopes(latest, "/collect-pressure", MAX_PROMPT_SESSIONS * 2)
    pressure.unmount()
    cleanup()

    const second = render(() => (
      <PromptProvider directory="/collect-repo" sessionId={sessionId}>
        <Probe />
      </PromptProvider>
    ))
    await waitFor(() => expect(second.getByTestId("prompt").textContent).toBe(""))
  })

  // Defect 1, runtime half: the field the vendored v2 attachment writer sets must
  // survive `clonePart`'s copy into the draft store. (The half that could FAIL
  // before the fix is the compile-time tripwire in prompt.tsx — this file is
  // excluded from `tsconfig.json`, so a type error here would not be checked.)
  test("preserves an image attachment's sourcePath through the draft store", async () => {
    setSessionId("image-a")
    const view = render(() => (
      <PromptProvider directory="/image-repo" sessionId={sessionId}>
        <Probe />
      </PromptProvider>
    ))

    const attachment: ImageAttachmentPart = {
      type: "image",
      id: "img-1",
      filename: "shot.png",
      mime: "image/png",
      dataUrl: "data:image/png;base64,AAAA",
      sourcePath: "/Users/me/Pictures/shot.png",
    }
    latest.set([...text("look "), attachment], 5)
    await waitFor(() => expect(view.getByTestId("prompt").textContent).toBe("look "))

    expect(latest.current().find((part) => part.type === "image")).toMatchObject({
      id: "img-1",
      sourcePath: "/Users/me/Pictures/shot.png",
    })
  })
})
