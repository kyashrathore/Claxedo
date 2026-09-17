import { afterEach, describe, expect, test } from "vitest"
import { createSignal } from "solid-js"
import { cleanup, render, waitFor } from "@solidjs/testing-library"
import type { AgentContentPart, AgentPresentationMessage } from "@claxedo/agent-runtime-contract"
import { SessionConversationOwner } from "./session-conversation-owner"
import {
  clearConversationChatRegistryForTest,
  registeredConversationSnapshot,
  warmConversationMemorySnapshot,
} from "./conversation-registry"

afterEach(() => {
  cleanup()
  clearConversationChatRegistryForTest()
})

describe("SessionConversationOwner", () => {
  test("hydrates reactive canonical rows and retains the shared client until both mounts release it", async () => {
    const [messages, setMessages] = createSignal<AgentPresentationMessage[]>()
    const [parts, setParts] = createSignal<AgentContentPart[]>([])
    const mount = () => render(() => (
      <SessionConversationOwner directory="/repo" sessionId="ses_owner" messages={messages} parts={() => parts()} />
    ))
    const first = mount()
    const second = mount()
    expect(warmConversationMemorySnapshot()).toMatchObject([
      { sessionId: "ses_owner", mounted: true, messageCount: 0 },
    ])

    setParts([{ id: "part_prompt", sessionID: "ses_owner", messageID: "msg_user", type: "text", text: "hello" }])
    setMessages([{
      id: "msg_user", sessionID: "ses_owner", role: "user", time: { created: 1 },
      agent: "assistant", model: { providerID: "openai", modelID: "gpt-4o" },
    }])
    await waitFor(() => expect(registeredConversationSnapshot("/repo", "ses_owner")).toMatchObject({
      messages: [{ id: "msg_user", role: "user" }],
      parts: { msg_user: [{ id: "part_prompt", text: "hello" }] },
    }))

    setParts([{ id: "part_prompt", sessionID: "ses_owner", messageID: "msg_user", type: "text", text: "hello again" }])
    await waitFor(() => expect(registeredConversationSnapshot("/repo", "ses_owner").parts.msg_user)
      .toMatchObject([{ text: "hello again" }]))

    first.unmount()
    expect(warmConversationMemorySnapshot()).toMatchObject([{ mounted: true, messageCount: 1 }])
    second.unmount()
    expect(warmConversationMemorySnapshot()).toMatchObject([{ mounted: false, messageCount: 1 }])
    expect(registeredConversationSnapshot("/repo", "ses_owner").messages.map((message) => message.id))
      .toEqual(["msg_user"])
  })
})
