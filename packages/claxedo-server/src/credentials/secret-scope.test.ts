import { describe, expect, test } from "vitest"
import { credentialSecretInScope } from "./secret-scope"

describe("credential secret scope policy", () => {
  test("shared runtime snapshots only include managed credentials", () => {
    expect(credentialSecretInScope({ source: "managed" }, "shared")).toBe(true)
    expect(credentialSecretInScope({ source: "local_only" }, "shared")).toBe(false)
    expect(credentialSecretInScope({ source: "env" }, "shared")).toBe(false)
    expect(credentialSecretInScope({ source: "upstream_sync" }, "shared")).toBe(false)
  })

  test("local runtime snapshots preserve existing credential sources", () => {
    expect(credentialSecretInScope({ source: "managed" })).toBe(true)
    expect(credentialSecretInScope({ source: "local_only" })).toBe(true)
    expect(credentialSecretInScope({ source: "env" })).toBe(true)
    expect(credentialSecretInScope({ source: "upstream_sync" })).toBe(true)
  })
})
