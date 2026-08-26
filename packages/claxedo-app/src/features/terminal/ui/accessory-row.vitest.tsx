import { afterEach, describe, expect, test, vi } from "vitest"
import { createSignal, flush, onCleanup, onSettled } from "solid-js"
import { cleanup, createEvent, fireEvent, render } from "@solidjs/testing-library"
import { TerminalAccessoryRow } from "./accessory-row"

afterEach(cleanup)

// These tests exercise the ACTUAL shipping wiring from terminal.tsx, not a
// standalone `visible={() => true}` mount. In production the row is a fixed
// sibling of the terminal container:
//
//   <div ref={container} onFocusIn=…terminalFocused(true) onFocusOut=…false />
//   <TerminalAccessoryRow onKey={inject} active={terminalFocused} />
//
// so the row's visibility is gated on the terminal keeping DOM focus. A key tap
// must therefore NOT steal focus, or the container fires `focusout`, `active()`
// flips false, and the row unmounts before the key reaches the PTY. jsdom does
// not implement the browser's "pointerdown/mousedown moves focus to the target"
// default, so `Harness`/`tap` model it explicitly: a tap only steals focus when
// the handler leaves the pointerdown default un-prevented. That is exactly the
// regression the previous suite (static `visible`+`active` props, no focus
// wiring) was structurally blind to.

// `fireEvent` flushes the scheduler for us (see vitest.setup.ts), but a direct
// `el.focus()` / `el.blur()` does not: it dispatches focusin/focusout
// synchronously, the handler's write is staged, and the row's visibility only
// lands on the next flush. In a browser that flush happens before paint, so
// these helpers keep the specs reading the way the user sees it.
const focus = (el: HTMLElement) => {
  el.focus()
  flush()
}
const blur = (el: HTMLElement) => {
  el.blur()
  flush()
}

/** Mirror of terminal.tsx's accessory-row wiring: container focus drives `active`. */
function Harness(props: { onKey: (data: string) => void }) {
  const [terminalFocused, setTerminalFocused] = createSignal(false)
  let container!: HTMLDivElement
  onSettled(() => {
    const onFocusIn = () => setTerminalFocused(true)
    const onFocusOut = () => setTerminalFocused(false)
    container.addEventListener("focusin", onFocusIn)
    container.addEventListener("focusout", onFocusOut)
    return () => {
      container.removeEventListener("focusin", onFocusIn)
      container.removeEventListener("focusout", onFocusOut)
    }
  })
  return (
    <>
      <div ref={container} data-component="terminal" tabindex={-1}>
        {/* Stand-in for xterm's hidden textarea — the real focus holder. */}
        <textarea data-testid="xterm-textarea" />
      </div>
      {/* `visible` overrides ONLY the media gate (jsdom lacks matchMedia); the
          `active` focus gate is wired for real, exactly as it ships. */}
      <TerminalAccessoryRow onKey={props.onKey} active={terminalFocused} visible={() => true} />
    </>
  )
}

/**
 * Simulate a real touch/click on `el`, modeling the browser default jsdom omits:
 * pointerdown/mousedown moves focus to the tapped control UNLESS the handler
 * calls preventDefault. If focus moves, the currently-focused terminal textarea
 * blurs (firing bubbling `focusout` on the container).
 */
function tap(el: HTMLElement, focusHolder: HTMLElement) {
  const down = createEvent.pointerDown(el, { bubbles: true, cancelable: true })
  fireEvent(el, down)
  const mouseDown = createEvent.mouseDown(el, { bubbles: true, cancelable: true })
  fireEvent(el, mouseDown)
  if (!down.defaultPrevented && !mouseDown.defaultPrevented) {
    // Browser default: focus shifts to the tapped, focusable control.
    blur(focusHolder)
    focus(el)
  }
  fireEvent.click(el)
}

describe("TerminalAccessoryRow — real terminal.tsx wiring", () => {
  test("row appears once the terminal is focused and hides when it blurs", () => {
    const { getByTestId, queryByRole } = render(() => <Harness onKey={() => {}} />)
    const textarea = getByTestId("xterm-textarea")

    expect(queryByRole("toolbar", { name: "Terminal keys" })).toBeNull()
    focus(textarea)
    expect(queryByRole("toolbar", { name: "Terminal keys" })).not.toBeNull()
    blur(textarea)
    expect(queryByRole("toolbar", { name: "Terminal keys" })).toBeNull()
  })

  test("REGRESSION: the row survives a tap and delivers the key without unmounting", () => {
    const onKey = vi.fn()
    const { getByTestId, getByRole, queryByRole } = render(() => <Harness onKey={onKey} />)
    const textarea = getByTestId("xterm-textarea")

    focus(textarea)
    expect(queryByRole("toolbar", { name: "Terminal keys" })).not.toBeNull()

    // Old wiring (plain onClick button, no preventDefault) would steal focus here
    // → container focusout → active() false → the row unmounts mid-tap and this
    // getByRole throws. The fix keeps focus on the textarea.
    tap(getByRole("button", { name: "Escape" }), textarea)

    expect(onKey).toHaveBeenCalledTimes(1)
    expect(onKey).toHaveBeenCalledWith("\x1b")
    // Row is still mounted and the terminal is still focused.
    expect(queryByRole("toolbar", { name: "Terminal keys" })).not.toBeNull()
    expect(document.activeElement).toBe(textarea)
  })

  test("REGRESSION: repeated taps all reach the PTY (row does not unmount between keys)", () => {
    const onKey = vi.fn()
    const { getByTestId, getByRole, queryByRole } = render(() => <Harness onKey={onKey} />)
    const textarea = getByTestId("xterm-textarea")
    focus(textarea)

    tap(getByRole("button", { name: "Up arrow" }), textarea)
    tap(getByRole("button", { name: "Down arrow" }), textarea)
    tap(getByRole("button", { name: "Tab" }), textarea)

    expect(onKey.mock.calls.map((c) => c[0])).toEqual(["\x1b[A", "\x1b[B", "\t"])
    expect(queryByRole("toolbar", { name: "Terminal keys" })).not.toBeNull()
    expect(document.activeElement).toBe(textarea)
  })

  test("sticky Ctrl survives taps: arm (no emit) then a Ctrl-modified arrow, then disarms", () => {
    const onKey = vi.fn()
    const { getByTestId, getByRole } = render(() => <Harness onKey={onKey} />)
    const textarea = getByTestId("xterm-textarea")
    focus(textarea)

    const ctrl = getByRole("button", { name: "Control" })
    tap(ctrl, textarea)
    expect(onKey).not.toHaveBeenCalled()
    expect(ctrl.getAttribute("aria-pressed")).toBe("true")

    tap(getByRole("button", { name: "Right arrow" }), textarea)
    expect(onKey).toHaveBeenCalledTimes(1)
    expect(onKey).toHaveBeenCalledWith("\x1b[1;5C")
    expect(ctrl.getAttribute("aria-pressed")).toBe("false")

    tap(getByRole("button", { name: "Right arrow" }), textarea)
    expect(onKey).toHaveBeenLastCalledWith("\x1b[C")
  })

  test("accessory keys are non-focus-stealing (tabIndex=-1 + pointerdown default prevented)", () => {
    const { getByTestId, getByRole } = render(() => <Harness onKey={() => {}} />)
    const textarea = getByTestId("xterm-textarea")
    focus(textarea)

    const esc = getByRole("button", { name: "Escape" })
    expect(esc.getAttribute("tabindex")).toBe("-1")

    const down = createEvent.pointerDown(esc, { bubbles: true, cancelable: true })
    fireEvent(esc, down)
    expect(down.defaultPrevented).toBe(true)
    const mouseDown = createEvent.mouseDown(esc, { bubbles: true, cancelable: true })
    fireEvent(esc, mouseDown)
    expect(mouseDown.defaultPrevented).toBe(true)
  })
})

describe("TerminalAccessoryRow — gate composition (media × focus)", () => {
  test("hidden on desktop even when focused (media gate off)", () => {
    const { queryByRole } = render(() => (
      <TerminalAccessoryRow onKey={() => {}} visible={() => false} active={() => true} />
    ))
    expect(queryByRole("toolbar", { name: "Terminal keys" })).toBeNull()
  })

  test("hidden on a mobile background pane (media on, focus off)", () => {
    const { queryByRole } = render(() => (
      <TerminalAccessoryRow onKey={() => {}} visible={() => true} active={() => false} />
    ))
    expect(queryByRole("toolbar", { name: "Terminal keys" })).toBeNull()
  })

  test("visible only when BOTH the media gate and terminal focus are on", () => {
    const { queryByRole } = render(() => (
      <TerminalAccessoryRow onKey={() => {}} visible={() => true} active={() => true} />
    ))
    expect(queryByRole("toolbar", { name: "Terminal keys" })).not.toBeNull()
  })
})
