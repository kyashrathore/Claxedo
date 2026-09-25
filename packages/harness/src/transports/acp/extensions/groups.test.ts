import { expect, test } from "bun:test"
import { PROTOCOL_VERSION, type InitializeResponse } from "@agentclientprotocol/sdk"
import { acpGroups } from "./groups"

test("ACP optional groups ignore identity and unsupported extension versions", () => {
  const handshake: InitializeResponse = { protocolVersion: PROTOCOL_VERSION,
    agentInfo: { name: "steer-agents-goals-health", version: "1" },
    _meta: { claxedo: { version: 2, methods: ["session/steer", "session/agents/list"], health: true },
      goal: { version: 2, methods: ["session/goal/get", "session/goal/start", "session/goal/stop"], actions: [] } } }
  expect(acpGroups(handshake)).toEqual({ steer: false, agents: false, health: false,
    goals: { implemented: false, available: false, actions: [], recovery: "blocked", optionalFields: [] } })
})
