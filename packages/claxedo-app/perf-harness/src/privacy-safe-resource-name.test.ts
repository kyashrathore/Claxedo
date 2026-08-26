import { describe, expect, test } from "bun:test"
import { privacySafeResourceName } from "./privacy-safe-resource-name"

describe("privacySafeResourceName", () => {
  test("retains privacy-safe session endpoint identity", () => {
    expect(privacySafeResourceName("http://127.0.0.1/session/ses_secret/message?view=latest-surface")).toBe("session-message")
    expect(privacySafeResourceName("http://127.0.0.1/session/ses_secret/subagents?directory=%2Frepo")).toBe("session-subagents")
    expect(privacySafeResourceName("http://127.0.0.1/session/ses_secret/capabilities")).toBe("session-capabilities")
    expect(privacySafeResourceName("http://127.0.0.1/session/ses_secret/todo")).toBe("session-todo")
    expect(privacySafeResourceName("http://127.0.0.1/session/status?directory=%2Frepo")).toBe("session-status")
    expect(privacySafeResourceName("http://127.0.0.1/session/ses_secret?directory=%2Frepo")).toBe("session-detail")
    expect(privacySafeResourceName("http://127.0.0.1/session?directory=%2Frepo")).toBe("session-list")
  })

  test("does not retain session ids or query values", () => {
    const label = privacySafeResourceName("http://127.0.0.1/session/private-session/subagents?directory=%2Fprivate%2Frepo")
    expect(label).toBe("session-subagents")
    expect(label).not.toContain("private-session")
    expect(label).not.toContain("repo")
  })
})
