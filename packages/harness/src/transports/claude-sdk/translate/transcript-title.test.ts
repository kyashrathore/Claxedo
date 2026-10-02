import { describe, expect, test } from "bun:test"
import { claudeTranscriptTitle } from "./transcript-title"

describe("claudeTranscriptTitle", () => {
  test("maps the CLI's transcript title entries to session titles by provenance", () => {
    expect(claudeTranscriptTitle({ type: "ai-title", aiTitle: "Date parser leap year tests", sessionId: "5bfc9161-3459-4626-9aa5-ba24c68022b6" }))
      .toEqual([{ type: "session-title", title: "Date parser leap year tests" }])
    expect(claudeTranscriptTitle({ type: "custom-title", customTitle: "Merge branch to dev", sessionId: "9cbf76fb-9c13-4eeb-a69f-693d34956b0f" }))
      .toEqual([{ type: "session-title", title: "Merge branch to dev", titleSource: "user" }])
    expect(claudeTranscriptTitle({ type: "attachment", attachment: { type: "goal_status", met: true } })).toEqual([])
  })
})
