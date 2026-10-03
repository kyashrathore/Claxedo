import { describe, expect, test } from "vitest"
import { providerAuthMethods, providerAuthMethodsForHarness } from "./methods"

describe("where every session runs in a cloud sandbox", () => {
  test("only methods whose account a sandbox can be delivered are served, for every harness", () => {
    const cloud = providerAuthMethods("cloud")
    expect(cloud["codex-app-server"]).toEqual([{ type: "api", label: "API Key" }])
    expect(cloud.openai).toEqual([{ type: "api", label: "API Key" }])
    expect(cloud["claude-sdk"]?.map((method) => method.type)).toEqual(["token", "api"])
    expect(providerAuthMethodsForHarness("codex", { reach: "cloud" })).toEqual({ "codex-app-server": [{ type: "api", label: "API Key" }] })
    expect(providerAuthMethodsForHarness("pi", { reach: "cloud" })).not.toHaveProperty("openai-codex")
    expect(providerAuthMethodsForHarness("pi")?.["openai-codex"]).toEqual([{ type: "oauth", label: "ChatGPT Pro/Plus (headless)" }])
  })
})
