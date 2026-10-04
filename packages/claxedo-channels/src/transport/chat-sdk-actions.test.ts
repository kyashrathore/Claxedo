import { describe, expect, test } from "vitest"
import { APPROVAL_ACTION_ID, chatSdkApprovalPress } from "./chat-sdk-actions"

/** The shape `Chat.onAction` delivers: `ActionEvent` from the installed SDK. */
function press(overrides: Record<string, unknown> = {}) {
  return {
    actionId: APPROVAL_ACTION_ID.approve,
    value: "a7f3",
    messageId: "1710000000.123",
    threadId: "C456:1710000000.100",
    adapter: { name: "slack" },
    user: { userId: "U123", userName: "octocat", fullName: "Octo Cat", isBot: false, isMe: false },
    raw: {},
    ...overrides,
  }
}

describe("chatSdkApprovalPress", () => {
  test("an approve button press is read by its exact action id", () => {
    expect(chatSdkApprovalPress(press())).toEqual({
      actionId: APPROVAL_ACTION_ID.approve,
      messageId: "1710000000.123",
      actorExternalUserId: "U123",
      approved: true,
      token: "a7f3",
    })
  })

  test("a deny button press is read by its exact action id", () => {
    expect(chatSdkApprovalPress(press({ actionId: APPROVAL_ACTION_ID.deny }))).toMatchObject({ approved: false, token: "a7f3" })
  })

  test("an action id that merely contains the keyword is not an approval", () => {
    for (const actionId of ["approve_permission", "claxedo_approve_v2", "I do not approve this", "deny", "yes", "yesterday", "allow", "once"]) {
      expect(chatSdkApprovalPress(press({ actionId }))).toBeUndefined()
    }
  })

  test("the button value is the token verbatim, never interpreted", () => {
    // A value is the token the card was rendered with. The words in it decide
    // nothing: an approve button whose value reads like a denial still approves
    // exactly what its token names, and vice versa.
    expect(chatSdkApprovalPress(press({ value: "deny" }))).toMatchObject({ approved: true, token: "deny" })
    expect(chatSdkApprovalPress(press({ actionId: APPROVAL_ACTION_ID.deny, value: "approve" }))).toMatchObject({ approved: false, token: "approve" })
  })

  test("free-text fields the SDK does not send decide nothing", () => {
    expect(chatSdkApprovalPress(press({ actionId: undefined, approved: true }))).toBeUndefined()
    expect(chatSdkApprovalPress(press({ actionId: undefined, data: { token: "a7f3", approved: true } }))).toBeUndefined()
    expect(chatSdkApprovalPress(press({ actionId: undefined, payload: { decision: "approve" } }))).toBeUndefined()
  })

  test("a press with no token, no message id, or no actor is not an approval", () => {
    expect(chatSdkApprovalPress(press({ value: undefined }))).toBeUndefined()
    expect(chatSdkApprovalPress(press({ value: "   " }))).toBeUndefined()
    expect(chatSdkApprovalPress(press({ messageId: undefined }))).toBeUndefined()
    expect(chatSdkApprovalPress(press({ user: undefined }))).toBeUndefined()
  })

  test("refuses a press that names only a handle", () => {
    // `userName` is renameable and reassignable; the approval bridge compares
    // the actor against the requestee recorded when the prompt was posted, so a
    // handle standing in for the id would let a later owner of that handle
    // answer someone else's prompt.
    expect(chatSdkApprovalPress(press({ user: { userName: "octocat", fullName: "The Octocat" } }))).toBeUndefined()
    expect(chatSdkApprovalPress(press({ user: undefined, userId: "U123" }))).toBeUndefined()
  })

  test("ignores non-object input", () => {
    expect(chatSdkApprovalPress(undefined)).toBeUndefined()
    expect(chatSdkApprovalPress("approve")).toBeUndefined()
  })
})
