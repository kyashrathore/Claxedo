import { describe, expect, test } from "vitest"
import { emptyUserAgentConfig, type UserAgentConfig } from "@claxedo/server-core/agent-config/config"
import { defaultSessionHarnessId } from "./default-session-harness"

const repository = (config: UserAgentConfig) => ({ read: async () => config, write: async () => {} })

describe("the harness a session created with none named runs", () => {
  test("is the person's default, a connection's access, or the deployment's provisioned runner", async () => {
    const empty = emptyUserAgentConfig()
    expect(await defaultSessionHarnessId(repository({ ...empty, defaultHarness: { kind: "native", harnessId: "pi" } }), {})("user_1")).toBe("pi")
    expect(await defaultSessionHarnessId(repository({ ...empty, defaultConnectionId: "conn_1" }), {})("user_1")).toBe("connection")
    expect(await defaultSessionHarnessId(repository(empty), { CLAXEDO_RUNTIME_RUNNER: "codex" })("user_1")).toBe("codex")
    expect(await defaultSessionHarnessId(repository(empty), {})("user_1")).toBeUndefined()
  })
})
