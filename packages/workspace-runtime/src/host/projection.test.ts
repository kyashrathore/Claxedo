import { describe, expect, test } from "bun:test"
import { pluginProjectionFor } from "./projection"

const root = { pluginInstanceId: "pi_review", root: "/runtime/generations/g7/plugins/review", dataRoot: "/runtime/data/pi_review" }
const harnessLaunch = { claude: { generation: "generation-7-abc", pluginRoots: [root] } }

describe("pluginProjectionFor", () => {
  test("carries the materializer's generation and plugin identities into the start projection", () => {
    expect(pluginProjectionFor({ id: "claude", access: "native" }, { generation: "runtime-config:3", mcp: {}, harnessLaunch })).toEqual({
      generation: "runtime-config:3/plugins:generation-7-abc",
      mcpServers: [],
      pluginRoots: [root],
      notApplied: [],
    })
  })

  test("a harness without a launch row starts on the runtime generation alone", () => {
    expect(pluginProjectionFor({ id: "codex", access: "native" }, { generation: "runtime-config:3", mcp: {}, harnessLaunch }))
      .toMatchObject({ generation: "runtime-config:3", pluginRoots: [] })
  })

  test("a launch row with bare paths is refused rather than rebuilt into identities", () => {
    expect(() => pluginProjectionFor({ id: "claude", access: "native" }, {
      generation: "runtime-config:3", mcp: {}, harnessLaunch: { claude: { generation: "g", pluginRoots: [root.root] } },
    })).toThrow("without pluginInstanceId, root and dataRoot")
    expect(() => pluginProjectionFor({ id: "claude", access: "native" }, {
      generation: "runtime-config:3", mcp: {}, harnessLaunch: { claude: { pluginRoots: [root] } },
    })).toThrow("must name its generation")
  })
})
