import { describe, expect, test } from "vitest"
import { chatSdkApprovalDecision } from "./chat-sdk-actions"

describe("chatSdkApprovalDecision", () => {
  test("parses approval actions from flat payloads", () => {
    expect(chatSdkApprovalDecision({
      actionId: "approve_permission",
      callId: "ses_1:perm_1",
      user: { id: "U123" },
    })).toEqual({
      callId: "ses_1:perm_1",
      approved: true,
      actorExternalUserId: "U123",
    })
  })

  test("parses denial actions from nested payload/data shapes", () => {
    expect(chatSdkApprovalDecision({
      payload: { permission_id: "ses_1:perm_2", value: "deny" },
      data: { userId: "discord-user" },
    })).toEqual({
      callId: "ses_1:perm_2",
      approved: false,
      actorExternalUserId: "discord-user",
    })
  })

  test("parses token-only approval actions", () => {
    expect(chatSdkApprovalDecision({
      data: { token: "a7f3", approved: true },
      user: { id: "U123" },
    })).toEqual({
      token: "a7f3",
      approved: true,
      actorExternalUserId: "U123",
    })
  })

  test("parses Slack button action payloads", () => {
    expect(chatSdkApprovalDecision({
      action_id: "approve_permission",
      user: { id: "U123" },
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
      interaction: { user: { id: "discord-user" } },
    })).toEqual({
      callId: "ses_1:perm_3",
      approved: false,
      actorExternalUserId: "discord-user",
    })
  })

  test("ignores incomplete action payloads", () => {
    expect(chatSdkApprovalDecision({ value: "approve" })).toBeUndefined()
  })
})
