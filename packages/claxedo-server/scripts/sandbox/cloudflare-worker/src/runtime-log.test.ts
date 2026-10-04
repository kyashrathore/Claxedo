import { describe, expect, test } from "vitest"
import { safeRuntimeLog } from "./runtime-log"

describe("runtime log scrubbing", () => {
  test.each([
    ["Authorization: Bearer abc.def-123", "Authorization: Bearer [REDACTED]"],
    ["Authorization: Basic eC1hY2Nlc3MtdG9rZW46Z2hzX3NlY3JldA==", "Authorization: Basic [REDACTED]"],
    ["Authorization: token gho_abc", "Authorization: token [REDACTED]"],
    ["clone with ghp_0123456789abcdefghijABCDEFGHIJ failed", "clone with [REDACTED] failed"],
    ["installation ghs_0123456789abcdefghijABCDEFGHIJ", "installation [REDACTED]"],
    ["pat github_pat_11ABCDEFG0123456789_abcdefghijklmnop", "pat [REDACTED]"],
    ["fatal: https://x-access-token:secret-value@github.com/acme/private.git", "fatal: https://[REDACTED]@github.com/acme/private.git"],
    ['{"GITHUB_TOKEN":"value","other":"kept"}', '{"GITHUB_TOKEN":"[REDACTED]","other":"kept"}'],
    ['{"apiSecret": "va\\"lue"}', '{"apiSecret": "[REDACTED]"}'],
    ["CLAXEDO_API_TOKEN=abc next", "CLAXEDO_API_TOKEN=[REDACTED] next"],
    ["https://host/cb?token=abc&state=kept", "https://host/cb?token=[REDACTED]&state=kept"],
    ["client_secret=abc password=hunter2", "client_secret=[REDACTED] password=[REDACTED]"],
    ["-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----", "[REDACTED PEM]"],
    ["fatal: couldn't find remote ref refs/heads/missing", "fatal: couldn't find remote ref refs/heads/missing"],
  ])("%j", (input, expected) => {
    expect(safeRuntimeLog(input)).toBe(expected)
  })
})
