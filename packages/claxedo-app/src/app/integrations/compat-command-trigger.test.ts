import { describe, expect, test } from "bun:test"
import { createCommandBus } from "./command-bus"
import {
  legacyCommandSource,
  legacyCommandTrigger,
  legacyCommandTriggerType,
  type LegacyCommandTriggerCommand,
} from "./compat-command-trigger"

describe("legacy command bus bridge", () => {
  test("maps palette and keybind triggers to typed ui command sources", () => {
    expect(legacyCommandSource("palette")).toEqual({ kind: "ui", surface: "palette" })
    expect(legacyCommandSource("keybind")).toEqual({ kind: "ui", surface: "keybind" })
    expect(legacyCommandTrigger("theme.cycle", "keybind")).toEqual({
      type: legacyCommandTriggerType,
      payload: { id: "theme.cycle", legacySource: "keybind" },
      source: { kind: "ui", surface: "keybind" },
    })
  })

  test("maps slash triggers to peer slash command sources", async () => {
    const bus = createCommandBus()
    const seen: LegacyCommandTriggerCommand[] = []
    bus.register(legacyCommandTriggerType, (command) => {
      seen.push(command)
    })

    await bus.dispatch(legacyCommandTrigger("workspace.toggle", "slash"))

    expect(seen).toEqual([{
      type: legacyCommandTriggerType,
      payload: { id: "workspace.toggle", legacySource: "slash" },
      source: { kind: "slash" },
    }])
  })
})
