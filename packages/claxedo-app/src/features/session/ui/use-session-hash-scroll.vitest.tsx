import { afterEach } from "vitest"
import { describe, expect, test, vi } from "vitest"
import { render, cleanup } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import { SessionParamsProvider } from "@/features/session/providers/session-params"

// The router is central to this defect: `updateHash` authors `#message-<id>` and
// the hash later reverts while the seek is still settling. Both transitions are
// driven explicitly here.
const routerState = vi.hoisted(() => {
  const state: {
    surfaceHash: boolean
    navigations: string[]
    hash: () => string
    setHash: (value: string) => void
  } = { surfaceHash: true, navigations: [], hash: () => "", setHash: () => {} }
  return state
})

vi.mock("@solidjs/router", () => ({
  useLocation: () => ({
    get hash() {
      return routerState.hash()
    },
    pathname: "/session",
    search: "",
  }),
  useNavigate: () => (to: string) => {
    routerState.navigations.push(to)
    if (!routerState.surfaceHash) return
    const index = to.indexOf("#")
    routerState.setHash(index >= 0 ? to.slice(index) : "")
  },
}))

const { useSessionHashScroll } = await import("./use-session-hash-scroll")

// A full SDK UserMessage would pin this test to fields the navigation never touches.
// as-any: the hook only reads `message.id`.
const message = { id: "msg_1", role: "user" } as unknown as UserMessage

function mount(options: { active?: () => boolean } = {}) {
  routerState.navigations = []
  routerState.surfaceHash = true
  const [hash, setHash] = createSignal("")
  routerState.hash = hash
  routerState.setHash = setHash
  const [messagesReady, setMessagesReady] = createSignal(true)
  const [sessionKey, setSessionKey] = createSignal("session-a")
  const forceScrollToBottom = vi.fn()

  let api!: ReturnType<typeof useSessionHashScroll>
  const Probe = () => {
    api = useSessionHashScroll({
      sessionKey,
      sessionID: () => "ses_1",
      messagesReady,
      visibleUserMessages: () => [message],
      historyMore: () => false,
      historyLoading: () => false,
      loadMore: async () => {},
      currentMessageId: () => undefined,
      pendingMessage: () => undefined,
      setPendingMessage: () => {},
      setActiveMessage: () => {},
      autoScroll: { pause: () => {}, forceScrollToBottom },
      scroller: () => undefined,
      scrollToMessageOffset: () => false,
      anchor: (id) => `message-${id}`,
      scheduleScrollState: () => {},
      consumePendingMessage: () => undefined,
    })
    return null
  }
  render(() => (
    <SessionParamsProvider
      sessionId={() => "ses_1"}
      directory={() => "/repo"}
      paneId={() => "pane-1"}
      active={options.active ?? (() => true)}
    >
      <Probe />
    </SessionParamsProvider>
  ))
  return { api, forceScrollToBottom, setMessagesReady, setSessionKey, setHash }
}

// `applyHash` is dispatched through requestAnimationFrame, so every assertion has
// to flush frames or the negative ones pass trivially.
const flushFrames = async (count = 4) => {
  for (let index = 0; index < count; index++) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
}

afterEach(() => cleanup())

describe("useSessionHashScroll", () => {
  test("a session opened with no authored navigation still scrolls to the bottom", async () => {
    const h = mount()
    await flushFrames()

    expect(h.forceScrollToBottom).toHaveBeenCalled()
  })

  test("a superseded navigation clears the marker so a later mount still bottoms out", async () => {
    const h = mount()
    await flushFrames()
    h.api.scrollToMessage(message, "auto")
    await flushFrames()
    h.forceScrollToBottom.mockClear()

    h.api.clearMessageHash()
    h.setHash("")
    h.setMessagesReady(false)
    h.setMessagesReady(true)
    await flushFrames()

    expect(h.forceScrollToBottom).toHaveBeenCalled()
  })

  test("an authored navigation does not leak across sessions", async () => {
    const h = mount()
    await flushFrames()
    h.api.scrollToMessage(message, "auto")
    await flushFrames()
    h.forceScrollToBottom.mockClear()

    h.setSessionKey("session-b")
    h.setHash("")
    await flushFrames()

    expect(h.forceScrollToBottom).toHaveBeenCalled()
  })

})
