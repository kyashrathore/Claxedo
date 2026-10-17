import { expect, test } from "bun:test"
import type { DraftLaunch } from "../../contract"
import { claudeProbeModel } from "./models"

const draft = (patch: Partial<DraftLaunch> = {}): DraftLaunch => ({
  workspaceId: "w1", directory: "/work", locality: "local", owner: { kind: "person", userId: "member" },
  config: { harness: { id: "claude", access: "native" } }, projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] },
  credentials: { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: {}, secrets: {}, leaseGeneration: "lease-1" },
  ...patch,
})

test("a catalog probe for a draft that names its model asks Claude Code with that model, so the list it answers is the one that model runs from", () => {
  expect(claudeProbeModel(draft({ model: { providerID: "claude", modelID: "claude-haiku-4-5-20251001" } }))).toEqual({ model: "claude-haiku-4-5-20251001" })
  expect(claudeProbeModel(draft())).toEqual({})
})
