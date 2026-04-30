import { describe, expect, test } from "bun:test"
import { dict } from "../i18n/en"
import type { UiI18n } from "../context/i18n"
import { sessionRetryMessage } from "./session-retry-text"

const i18n: UiI18n = {
  locale: () => "en",
  t(key) {
    return dict[key] ?? key
  },
}

describe("session retry helpers", () => {
  test("renders recovering status as ACP recovery copy", () => {
    expect(sessionRetryMessage({
      type: "recovering",
      kind: "process_restart",
      message: "ACP process restarted; pending interactive state must be rerun",
    }, i18n)).toBe("Recovering ACP client...")
  })

  test("keeps existing Gemini retry copy", () => {
    expect(sessionRetryMessage({
      type: "retry",
      attempt: 1,
      message: "gemini exceeded your current quota",
      next: Date.now(),
    }, i18n)).toBe(dict["ui.sessionTurn.retry.geminiHot"])
  })
})
