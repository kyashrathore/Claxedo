import { describe, expect, test } from "bun:test"
import {
  createLeakedInputModeReclaimer,
  KITTY_KEYBOARD_DISARM_SEQUENCE,
  LEAKED_MODE_DISARM,
} from "./leaked-input-mode-reclaim"

describe("createLeakedInputModeReclaimer", () => {
  test("disarms kitty left armed by a TUI killed before the next prompt", () => {
    const r = createLeakedInputModeReclaimer()
    r.noteShellReady() // shell prompt: epoch starts
    r.noteArm("kitty", true) // TUI starts
    r.noteShellReady() // TUI died; shell is back
    expect(r.collectDisarm()).toBe(KITTY_KEYBOARD_DISARM_SEQUENCE)
  })

  test("does not disarm a mode a TUI restored itself on clean exit", () => {
    const r = createLeakedInputModeReclaimer()
    r.noteShellReady()
    r.noteArm("kitty", true)
    r.noteArm("kitty", false) // clean exit restores it
    r.noteShellReady()
    expect(r.collectDisarm()).toBe("")
  })

  test("leaves modes armed by shell init alone (shell-owned)", () => {
    const r = createLeakedInputModeReclaimer()
    // Armed during .zshrc, before any prompt marker — e.g. a live tmux.
    r.noteArm("mouse", true)
    r.noteShellReady()
    expect(r.collectDisarm()).toBe("")
  })

  test("a mode re-armed before collection is not disarmed (TUI racing the prompt)", () => {
    const r = createLeakedInputModeReclaimer()
    r.noteShellReady()
    r.noteArm("mouse", true)
    r.noteShellReady() // marked as leaked...
    r.noteArm("mouse", true) // ...but a new TUI armed it again
    expect(r.collectDisarm()).toBe("")
  })

  test("reclaims mouse and focus reporting together", () => {
    const r = createLeakedInputModeReclaimer()
    r.noteShellReady()
    r.noteArm("mouse", true)
    r.noteArm("focus", true)
    r.noteShellReady()
    const disarm = r.collectDisarm()
    expect(disarm).toContain(LEAKED_MODE_DISARM.mouse)
    expect(disarm).toContain(LEAKED_MODE_DISARM.focus)
  })

  test("consumes the pending set — a second collect is empty", () => {
    const r = createLeakedInputModeReclaimer()
    r.noteShellReady()
    r.noteArm("mouse", true)
    r.noteShellReady()
    expect(r.collectDisarm()).not.toBe("")
    expect(r.collectDisarm()).toBe("")
  })

  test("writes nothing when no TUI mode ever leaked", () => {
    const r = createLeakedInputModeReclaimer()
    r.noteShellReady()
    r.noteShellReady()
    expect(r.collectDisarm()).toBe("")
  })

  test("a mode re-armed after a shell-owned disarm is no longer shell-owned", () => {
    const r = createLeakedInputModeReclaimer()
    r.noteArm("mouse", true) // shell init owns it
    r.noteShellReady()
    expect(r.collectDisarm()).toBe("")
    r.noteArm("mouse", false) // shell turns it off; ownership released
    r.noteArm("mouse", true) // a TUI arms it
    r.noteShellReady() // TUI dies
    expect(r.collectDisarm()).toBe(LEAKED_MODE_DISARM.mouse)
  })

  test("survives repeated prompts without a TUI (the common case)", () => {
    const r = createLeakedInputModeReclaimer()
    for (let i = 0; i < 50; i += 1) {
      r.noteShellReady()
      expect(r.collectDisarm()).toBe("")
    }
  })

  test("reclaims each of the three modes independently", () => {
    for (const mode of ["kitty", "mouse", "focus"] as const) {
      const r = createLeakedInputModeReclaimer()
      r.noteShellReady()
      r.noteArm(mode, true)
      r.noteShellReady()
      expect(r.collectDisarm()).toBe(LEAKED_MODE_DISARM[mode])
    }
  })
})
