import { describe, expect, test } from "vitest"
import { chatSdkApprovalDecision } from "./chat-sdk-actions"

describe("chatSdkApprovalDecision", () => {
  test("parses approval actions from flat payloads", () => {
    expect(chatSdkApprovalDecision({
      actionId: "approve_permission",
      callId: "ses_1:perm_1",
      user: { userId: "U123", userName: "octocat", fullName: "octocat" },
    })).toEqual({
      callId: "ses_1:perm_1",
      approved: true,
      actorExternalUserId: "U123",
    })
  })

  test("parses denial actions from nested payload/data shapes", () => {
    expect(chatSdkApprovalDecision({
      payload: { permission_id: "ses_1:perm_2", value: "deny" },
      user: { userId: "discord-user" },
    })).toEqual({
      callId: "ses_1:perm_2",
      approved: false,
      actorExternalUserId: "discord-user",
    })
  })

  test("parses token-only approval actions", () => {
    expect(chatSdkApprovalDecision({
      data: { token: "a7f3", approved: true },
      user: { userId: "U123" },
    })).toEqual({
      token: "a7f3",
      approved: true,
      actorExternalUserId: "U123",
    })
  })

  test("parses Slack button action payloads", () => {
    expect(chatSdkApprovalDecision({
      action_id: "approve_permission",
      user: { userId: "U123" },
      data: {
        token: "slack7",
        approved: true,
      },
    })).toEqual({
      token: "slack7",
      approved: true,
      actorExternalUserId: "U123",
    })
  })

  test("parses Discord interaction action payloads", () => {
    expect(chatSdkApprovalDecision({
      value: "deny",
      payload: { callId: "ses_1:perm_3" },
      user: { userId: "discord-user" },
    })).toEqual({
      callId: "ses_1:perm_3",
      approved: false,
      actorExternalUserId: "discord-user",
    })
  })

  test("refuses a press that names only a handle", () => {
    // `userName` is renameable and reassignable; the approval bridge compares
    // the actor against the requestee recorded when the prompt was posted, so a
    // handle standing in for the id would let a later owner of that handle
    // answer someone else's prompt.
    expect(chatSdkApprovalDecision({
      actionId: "approve_permission",
      callId: "ses_1:perm_1",
      user: { userName: "octocat", fullName: "The Octocat" },
    })).toBeUndefined()
    expect(chatSdkApprovalDecision({
      actionId: "approve_permission",
      callId: "ses_1:perm_1",
      userId: "U123",
    })).toBeUndefined()
  })

  test("ignores incomplete action payloads", () => {
    expect(chatSdkApprovalDecision({ value: "approve" })).toBeUndefined()
  })
})
