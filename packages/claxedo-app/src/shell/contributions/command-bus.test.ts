import { describe, expect, test } from "bun:test"
import { createCommandBus, type Command } from "./command-bus"
import { createContributionRegistry } from "./registry"

type SplitRightCommand = Command<"layout.splitRight", { paneId: string }>

describe("command bus and contribution registry", () => {
  test("dispatches the same typed command intent from peer sources", async () => {
    const bus = createCommandBus()
    const calls: SplitRightCommand[] = []
    bus.register<SplitRightCommand>("layout.splitRight", (command) => {
      calls.push(command)
    })

    await bus.dispatch<SplitRightCommand>({
      type: "layout.splitRight",
      payload: { paneId: "pane_1" },
      source: { kind: "ui", surface: "toolbar" },
    })
    await bus.dispatch<SplitRightCommand>({
      type: "layout.splitRight",
      payload: { paneId: "pane_1" },
      source: { kind: "voice-agent", agentId: "voice_1" },
    })
    await bus.dispatch<SplitRightCommand>({
      type: "layout.splitRight",
      payload: { paneId: "pane_1" },
      source: { kind: "server", eventId: "evt_1" },
    })

    expect(calls.map((command) => command.source.kind)).toEqual(["ui", "voice-agent", "server"])
    expect(calls.every((command) => command.type === "layout.splitRight")).toBe(true)
    expect(calls.every((command) => command.payload.paneId === "pane_1")).toBe(true)
  })

  test("records shell, first-party, and lease-bound agent contributions in one registry", async () => {
    const registry = createContributionRegistry()
    let invoked = false

    registry.addSurface({ id: "workbench.session", tier: "shell", surface: "workbench", slot: "main" })
    registry.addRenderer({ id: "renderer.markdown", tier: "claxedo-first-party", kind: "message-part" })
    registry.addCommand<Command<"agent.review", { sessionId: string }>>({
      id: "agent.review",
      tier: "lease-bound-agent",
      title: "Review Session",
      handler: () => {
        invoked = true
      },
    })

    expect(registry.all().surfaces.map((item) => item.id)).toEqual(["workbench.session"])
    expect(registry.all().renderers.map((item) => item.id)).toEqual(["renderer.markdown"])
    expect(registry.trustedAgentCommands().map((item) => item.id)).toEqual(["agent.review"])
    await registry.command("agent.review")?.handler({
      type: "agent.review",
      payload: { sessionId: "ses_1" },
      source: { kind: "remote-agent", agentId: "agent_1" },
    })
    expect(invoked).toBe(true)
  })
})
