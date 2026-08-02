import { describe, expect, test } from "vitest"
import {
  runApprovalJudge,
  type ApprovalJudge,
  type ApprovalRequest,
} from "../index"

function request(): ApprovalRequest {
  return {
    callId: "ses_1:perm_1",
    tool: "bash",
    summary: "Run command",
    sessionId: "ses_1",
    threadKey: "telegram:install:chat:thread",
  }
}

describe("runApprovalJudge", () => {
  test("passes the prompt, reply, and history to the judge", async () => {
    const seen: Parameters<ApprovalJudge>[0][] = []
    const verdict = await runApprovalJudge({
      judge: async (input) => {
        seen.push(input)
        return { decision: "approved" }
      },
      request: request(),
      text: "go ahead",
      history: [{ role: "assistant", text: "Should I run the migration?" }],
    })

    expect(verdict).toEqual({ decision: "approved" })
    expect(seen[0]?.text).toBe("go ahead")
    expect(seen[0]?.request.callId).toBe("ses_1:perm_1")
    expect(seen[0]?.history).toEqual([{ role: "assistant", text: "Should I run the migration?" }])
  })

  test("passes through a denial", async () => {
    await expect(runApprovalJudge({
      judge: async () => ({ decision: "denied" }),
      request: request(),
      text: "no, don't",
    })).resolves.toEqual({ decision: "denied" })
  })

  test("keeps the judge's own re-ask question when unclear", async () => {
    await expect(runApprovalJudge({
      judge: async () => ({ decision: "unclear", question: "Did you mean the migration or the deploy?" }),
      request: request(),
      text: "the second one",
    })).resolves.toEqual({
      decision: "unclear",
      question: "Did you mean the migration or the deploy?",
    })
  })

  test("a throwing judge degrades to unclear, never to a decision", async () => {
    await expect(runApprovalJudge({
      judge: async () => {
        throw new Error("model unavailable")
      },
      request: request(),
      text: "yes",
    })).resolves.toEqual({ decision: "unclear" })
  })

  test("a hung judge times out to unclear rather than wedging the approval", async () => {
    await expect(runApprovalJudge({
      judge: () => new Promise(() => {}),
      request: request(),
      text: "yes",
      timeoutMs: 5,
    })).resolves.toEqual({ decision: "unclear" })
  })

  test("a malformed verdict is unclear, not a silent approval", async () => {
    for (const bad of [undefined, null, {}, { decision: "yes" }, { decision: true }]) {
      await expect(runApprovalJudge({
        judge: async () => bad as never,
        request: request(),
        text: "yes",
      })).resolves.toEqual({ decision: "unclear" })
    }
  })
})
