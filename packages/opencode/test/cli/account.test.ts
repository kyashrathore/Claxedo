import { describe, expect, test } from "bun:test"
import stripAnsi from "strip-ansi"

import { defaultConsoleUrl, formatAccountLabel, formatLogoutMessage, formatOrgLine } from "../../src/cli/cmd/account"

describe("console account display", () => {
  test("uses console.opencode.ai as the default login URL", () => {
    expect(defaultConsoleUrl).toBe("https://console.opencode.ai")
  })

  test("includes the account url in account labels", () => {
    expect(stripAnsi(formatAccountLabel({ user_id: "usr_one", url: "https://one.example.com" }, false))).toBe(
      "usr_one https://one.example.com",
    )
  })

  test("includes the active marker in account labels", () => {
    expect(stripAnsi(formatAccountLabel({ user_id: "usr_one", url: "https://one.example.com" }, true))).toBe(
      "usr_one https://one.example.com (active)",
    )
  })

  test("includes the account url in org rows", () => {
    expect(
      stripAnsi(
        formatOrgLine({ user_id: "usr_one", url: "https://one.example.com" }, { id: "org-1", name: "One" }, true),
      ),
    ).toBe("  ● One  usr_one  https://one.example.com  org-1")
  })

  test("reports remote revocation separately from local-only logout", () => {
    expect(formatLogoutMessage("usr_one", { remoteRevocation: "revoked" })).toBe(
      "Logged out from usr_one; remote credentials revoked",
    )
    expect(formatLogoutMessage("usr_one", { remoteRevocation: "uncertain" })).toBe(
      "Logged out from usr_one; local credentials removed, remote revocation uncertain",
    )
  })
})
