import { describe, expect, test } from "bun:test"
import { acpSpawnEnv } from "./transport"

describe("ACP transport environment", () => {
  test("scrubs the local document installation secret from the child environment", () => {
    expect(acpSpawnEnv({
      PATH: "/bin",
      CLAXEDO_LOCAL_DOCUMENT_BROKER_TOKEN: "installation-secret",
    })).toEqual({ PATH: "/bin" })
  })
})
