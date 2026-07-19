import { describe, expect, test } from "bun:test"
import { claudeSpawnEnv, createClaudeSdkDriver } from "./driver"

describe("Claude SDK driver", () => {
  test("scrubs the local document installation secret from the child environment", () => {
    expect(claudeSpawnEnv({
      PATH: "/bin",
      CLAXEDO_LOCAL_DOCUMENT_BROKER_TOKEN: "installation-secret",
    })).toEqual({ PATH: "/bin" })
  })

  test("serves the static Claude model catalog before any live probe", () => {
    const driver = createClaudeSdkDriver({
      lifecycle: () => ({ set() {}, delete() {}, get() {}, activeTurns: new Map() }),
      pendingPermissions: new Map(),
      pendingQuestions: new Map(),
      bindSession() {},
    } as never)

    expect(driver.peekConfigOptions("claude-opus-4-6")).toEqual([
      expect.objectContaining({
        id: "model",
        currentValue: "claude-opus-4-6",
        selectOptions: expect.arrayContaining([
          expect.objectContaining({ id: "claude-sonnet-4-6" }),
          expect.objectContaining({ id: "claude-opus-4-6" }),
        ]),
      }),
    ])
  })
})
