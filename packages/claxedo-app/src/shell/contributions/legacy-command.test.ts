import { describe, expect, test } from "bun:test"
import { createCommandBus } from "./command-bus"
import {
  agentCommandFromEvent,
  legacyCommandSource,
  legacyCommandTrigger,
  legacyCommandTriggerType,
  serverCommandTriggerFromEvent,
  type LegacyCommandTriggerCommand,
} from "./legacy-command"

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
    bus.register<LegacyCommandTriggerCommand>(legacyCommandTriggerType, (command) => {
      seen.push(command)
    })

    await bus.dispatch(legacyCommandTrigger("workspace.toggle", "slash"))

    expect(seen).toEqual([{
      type: legacyCommandTriggerType,
      payload: { id: "workspace.toggle", legacySource: "slash" },
      source: { kind: "slash" },
    }])
  })

  test("maps server pushed command events to server command sources", () => {
    expect(serverCommandTriggerFromEvent({
      id: "evt_1",
      type: "command.trigger",
      properties: { id: "theme.cycle" },
    })).toEqual({
      type: legacyCommandTriggerType,
      payload: { id: "theme.cycle" },
      source: { kind: "server", eventId: "evt_1" },
    })
    expect(serverCommandTriggerFromEvent({
      id: "evt_2",
      type: "tui.command.execute",
      properties: { command: "session.new" },
    })).toEqual({
      type: legacyCommandTriggerType,
      payload: { id: "session.new" },
      source: { kind: "server", eventId: "evt_2" },
    })
  })

  test("maps remote and voice agent command events to peer agent command sources", () => {
    expect(agentCommandFromEvent({
      type: "remote-agent.command.execute",
      properties: {
        agentId: "agent_1",
        commandType: "layout.splitRight",
        payload: { paneId: "pane_1" },
      },
    })).toEqual({
      type: "layout.splitRight",
      payload: { paneId: "pane_1" },
      source: { kind: "remote-agent", agentId: "agent_1" },
    })
    expect(agentCommandFromEvent({
      type: "voice-agent.command.execute",
      properties: {
        agentId: "voice_1",
        command: "session.new",
      },
    })).toEqual({
      type: "session.new",
      payload: undefined,
      source: { kind: "voice-agent", agentId: "voice_1" },
    })
  })
})
