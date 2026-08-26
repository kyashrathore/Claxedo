import { cleanup, fireEvent, render } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import { MessageNav } from "@opencode-ai/session-ui/message-nav"

const message = (index: number): UserMessage =>
  ({
    id: `msg_${index}`,
    sessionID: "ses_1",
    role: "user",
    time: { created: index },
    agent: "build",
    model: { providerID: "test", modelID: "test" },
  }) as UserMessage

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("compact MessageNav shared preview owner", () => {
  test("closes when the active turn disappears and opens the next real turn", async () => {
    vi.useFakeTimers()
    const initial = Array.from({ length: 12 }, (_, index) => message(index + 1))
    const [messages, setMessages] = createSignal(initial)
    const view = render(() => (
      <MessageNav
        messages={messages()}
        current={messages()[0]}
        size="compact"
        onMessageSelect={() => {}}
        getLabel={(item) => `Turn ${item.id}`}
      />
    ))

    const first = view.getByRole("button", { name: "1. Turn msg_1" })
    fireEvent.focus(first)
    await vi.advanceTimersByTimeAsync(140)
    expect(document.querySelector("[data-slot='message-nav-turn-preview']")?.textContent).toContain("Turn msg_1")

    setMessages((items) => items.slice(1))
    await Promise.resolve()
    expect(document.querySelector("[data-slot='message-nav-turn-preview']")).toBeNull()

    const next = view.getByRole("button", { name: "1. Turn msg_2" })
    fireEvent.focus(next)
    await vi.advanceTimersByTimeAsync(140)
    expect(document.querySelector("[data-slot='message-nav-turn-preview']")?.textContent).toContain("Turn msg_2")
  })
})
