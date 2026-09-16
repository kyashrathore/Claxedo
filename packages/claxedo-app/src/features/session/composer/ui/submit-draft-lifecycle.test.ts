import { describe, expect, test } from "bun:test"
import type { Prompt, PromptDraftScope } from "@/features/session/providers/prompt"
import { createSubmitDraftLifecycle } from "./submit-draft-lifecycle"

const sent: Prompt = [{ type: "text", content: "ship it", start: 0, end: 7 }]
const draftScope: PromptDraftScope = { dir: "/repo", draftId: "surface-1" }
const sessionScope: PromptDraftScope = { dir: "/repo", id: "ses_created" }

function harness(input: { historyScope: PromptDraftScope; scopes: PromptDraftScope[] }) {
  const calls: string[] = []
  const lifecycle = createSubmitDraftLifecycle({
    prompt: {
      reset: (scope) => calls.push(`reset:${scope?.id ?? scope?.draftId}`),
      set: (_value, _cursor, scope) => calls.push(`set:${scope?.id ?? scope?.draftId}`),
    },
    current: sent,
    scopes: input.scopes,
    historyScope: input.historyScope,
    addToHistory: (prompt, mode, scope) => calls.push(`history:${mode}:${scope.id ?? scope.draftId}:${prompt.length}`),
    resetHistoryNavigation: () => calls.push("nav-reset"),
    length: (prompt) => prompt.reduce((total, part) => total + ("content" in part ? part.content.length : 0), 0),
    userMode: "shell",
    setMode: () => undefined,
    setPopover: () => undefined,
    editor: () => undefined,
    queueScroll: () => undefined,
  })
  return { calls, lifecycle }
}

describe("createSubmitDraftLifecycle", () => {
  test("clear records the send into the created session's history before the drafts reset", () => {
    const { calls, lifecycle } = harness({ historyScope: sessionScope, scopes: [draftScope, sessionScope] })
    lifecycle.clear()
    expect(calls).toEqual(["history:shell:ses_created:1", "nav-reset", "reset:surface-1", "reset:ses_created"])
  })

  test("restore puts the draft back without recording history", () => {
    const { calls, lifecycle } = harness({ historyScope: draftScope, scopes: [draftScope] })
    lifecycle.restore()
    expect(calls).toEqual(["set:surface-1"])
  })
})
