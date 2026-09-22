import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import * as i18n from "@solid-primitives/i18n"
import { dict } from "@/platform/i18n/en"
import { PreviousMessagesRow } from "./message-timeline-turn-rows"

// The real English strings through the provider's own resolver, so the label
// assertions below read what the app renders rather than a key echo.
vi.mock("@/platform/i18n/provider", () => ({
  useLanguage: () => ({ t: i18n.translator(() => dict, i18n.resolveTemplate) }),
}))

afterEach(cleanup)

describe("PreviousMessagesRow", () => {
  test("pluralizes the count and exposes it on the collapsed button", () => {
    render(() => <PreviousMessagesRow count={3} onReveal={() => {}} />)

    const button = screen.getByTestId("timeline-previous-messages")
    expect(button).toHaveTextContent("3 previous messages")
    expect(button).toHaveAttribute("data-count", "3")
    expect(button).toHaveAttribute("aria-expanded", "false")
  })

  test("uses the singular form for one hidden turn", () => {
    render(() => <PreviousMessagesRow count={1} onReveal={() => {}} />)

    expect(screen.getByTestId("timeline-previous-messages")).toHaveTextContent("1 previous message")
  })

  test("click reveals through the handler and does not bubble to the timeline", () => {
    const onReveal = vi.fn()
    const onOuterClick = vi.fn()
    render(() => (
      <div onClick={onOuterClick}>
        <PreviousMessagesRow count={2} onReveal={onReveal} />
      </div>
    ))

    fireEvent.click(screen.getByTestId("timeline-previous-messages"))

    expect(onReveal).toHaveBeenCalledTimes(1)
    expect(onOuterClick).not.toHaveBeenCalled()
  })

  test("a press does not take focus, so a composer the row sits beside keeps it", () => {
    render(() => <PreviousMessagesRow count={2} onReveal={() => {}} />)

    expect(fireEvent.mouseDown(screen.getByTestId("timeline-previous-messages"))).toBe(false)
  })
})
