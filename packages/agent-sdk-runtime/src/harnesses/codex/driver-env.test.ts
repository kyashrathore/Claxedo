import { describe, expect, test } from "bun:test"
import { codexSpawnEnv } from "./driver"

describe("Codex app-server environment", () => {
  test("scrubs the local document installation secret from the child environment", () => {
    expect(codexSpawnEnv({
      PATH: "/bin",
      CLAXEDO_LOCAL_DOCUMENT_BROKER_TOKEN: "installation-secret",
    })).toEqual({ PATH: "/bin" })
  })
})
