import { describe, expect, test } from "bun:test"
import { claudeRuntime as runtime } from "../test-support/runtime"

describe("claudeSdkAdapter", () => {
  test("maps the CLI's transcript title entries to session titles by provenance", () => {
    const agent = runtime()
    expect(agent.ingest({
      source: "claude.sdk",
      method: "claude/session-store",
      payload: { type: "ai-title", aiTitle: "Date parser leap year tests", sessionId: "5bfc9161-3459-4626-9aa5-ba24c68022b6" },
    }).events).toMatchObject([{ type: "session-title", title: "Date parser leap year tests" }])
    expect(agent.ingest({
      source: "claude.sdk",
      method: "claude/session-store",
      payload: { type: "custom-title", customTitle: "Merge branch to dev", sessionId: "9cbf76fb-9c13-4eeb-a69f-693d34956b0f" },
    }).events).toMatchObject([{ type: "session-title", title: "Merge branch to dev", titleSource: "user" }])
    expect(agent.ingest({
      source: "claude.sdk",
      method: "claude/session-store",
      payload: { type: "attachment", attachment: { type: "goal_status", met: true } },
    }).events).toEqual([])
  })
})
