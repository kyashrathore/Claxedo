import { describe, expect, test } from "bun:test"
import { appPluginIdOfToolGroup, appPluginToolGroupId, pluginToolCallPath } from "./tools"

describe("a plugin's tool group", () => {
  test("is named by the plugin, and only a plugin id under the prefix names one", () => {
    expect(appPluginToolGroupId("counter")).toBe("app-plugin:counter")
    expect(appPluginIdOfToolGroup("app-plugin:counter")).toBe("counter")
    for (const other of ["claxedo:tasks", "app-plugin:", "app-plugin:Counter", "app-plugin:a/b", "counter"]) {
      expect(appPluginIdOfToolGroup(other), other).toBeUndefined()
    }
  })

  test("is called at the plugin's own tool path", () => {
    expect(pluginToolCallPath("counter", "count_read")).toBe("/api/plugins/counter/_tools/count_read")
  })
})
