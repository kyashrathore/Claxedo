/// <reference types="bun" />
import { expect, test } from "bun:test"
import { surfaceComponentSchema } from "@claxedo/plugin-api/surface"
import { boundAgentConfiguration, boundAgentPlacement } from "./agent-configuration"

const UNCHOSEN = { harness: null, model: null, effort: null }

test("an AgentConfigurationPicker binds its value and may bind its placement", () => {
  const picker = { id: "primary", component: "AgentConfigurationPicker", placement: { path: "/placement" }, value: { path: "/primary" }, change: { event: { name: "configured" } } }
  expect(surfaceComponentSchema.safeParse(picker).success).toBe(true)
  expect(surfaceComponentSchema.safeParse({ ...picker, value: { harness: null, model: null, effort: null } }).success).toBe(false)
  expect(surfaceComponentSchema.safeParse({ ...picker, placement: "remote" }).success).toBe(false)
})

test("a bound configuration is drawn as given, and anything else as nothing chosen yet", () => {
  const chosen = { harness: { id: "claude", access: "native" }, model: { providerID: "claude", modelID: "default" }, effort: "high" } as const
  expect(boundAgentConfiguration(chosen)).toEqual(chosen)
  expect(boundAgentConfiguration(UNCHOSEN)).toEqual(UNCHOSEN)
  expect(boundAgentConfiguration(undefined)).toEqual(UNCHOSEN)
  expect(boundAgentConfiguration({ harness: { id: "claude", access: "remote" }, model: null, effort: null })).toEqual(UNCHOSEN)
  expect(boundAgentConfiguration({ ...chosen, extra: true })).toEqual(UNCHOSEN)
})

test("a placement other than cloud draws the local picker", () => {
  expect(boundAgentPlacement("cloud")).toBe("cloud")
  expect(boundAgentPlacement("local")).toBe("local")
  expect(boundAgentPlacement(undefined)).toBe("local")
})
