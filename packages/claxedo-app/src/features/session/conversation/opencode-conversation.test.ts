import { describe, expect, test } from "bun:test"
import type { Event, Message, Part } from "@opencode-ai/sdk/v2/client"
import type { MessagePart, UIMessage } from "@tanstack/ai"
import {
  applyOpencodeConversationEvent,
  mergeConversationSnapshot,
  opencodeConversationSnapshot,
  opencodeConversationProjection,
  type ConversationChatHandle,
} from "./opencode-conversation"

function message(id: string, role: "user" | "assistant" = "assistant"): Message {
  if (role === "user") {
    return {
      id,
      role,
      sessionID: "ses_1",
      time: { created: 1 },
      agent: "assistant",
      model: { providerID: "openai", modelID: "gpt-4o" },
      system: "system prompt",
    } as Message
  }
  return {
    id,
    role,
    sessionID: "ses_1",
    time: { created: 2 },
    parentID: "msg_user",
    modelID: "gpt-4o",
    providerID: "openai",
    mode: "chat",
    agent: "assistant",
    path: { cwd: "/repo", root: "/repo" },
    cost: 0.25,
    tokens: { input: 10, output: 5, reasoning: 3, cache: { read: 2, write: 1 } },
  } as Message
}

function textPart(id: string, messageID: string, text: string): Part {
  return {
    id,
    sessionID: "ses_1",
    messageID,
    type: "text",
    text,
  }
}

function reasoningPart(id: string, messageID: string, text: string): Part {
  return {
    id,
    sessionID: "ses_1",
    messageID,
    type: "reasoning",
    text,
    time: { start: 1 },
  }
}

function toolPart(id: string, messageID: string, status: "running" | "completed" = "running"): Part {
  return {
    id,
    sessionID: "ses_1",
    messageID,
    type: "tool",
    callID: "call_1",
    tool: "read",
    state: status === "running"
      ? { status, input: { file: "README.md" }, time: { start: 1 } }
      : { status, input: { file: "README.md" }, output: "ok", title: "Read", metadata: {}, time: { start: 1, end: 2 } },
  }
}

function agentPart(id: string, messageID: string, name: string): Part {
  return {
    id,
    sessionID: "ses_1",
    messageID,
    type: "agent",
    name,
    source: { value: `@${name}`, start: 0, end: name.length + 1 },
  } as Part
}

function event(type: string, properties: Record<string, unknown>): Event {
  return { type, properties } as Event
}

function chat(initial: UIMessage[] = []): ConversationChatHandle & { written: UIMessage[][] } {
  let current = initial
  const written: UIMessage[][] = []
  return {
    written,
    messages: () => current,
    setMessages: (messages) => {
      current = messages
      written.push(messages)
    },
  }
}

describe("opencode conversation chat adapter", () => {
  test("hydrates TanStack UI messages from OpenCode message and part snapshots", () => {
    expect(opencodeConversationSnapshot({
      messages: [message("msg_user", "user"), message("msg_assistant")],
      parts: {
        msg_user: [textPart("part_prompt", "msg_user", "hello")],
        msg_assistant: [
          reasoningPart("part_reason", "msg_assistant", "thinking"),
          textPart("part_text", "msg_assistant", "answer"),
          toolPart("part_tool", "msg_assistant", "completed"),
        ],
      },
    })).toMatchObject([
      {
        id: "msg_user",
        role: "user",
        metadata: {
          opencodeMessage: { system: "system prompt" },
        },
        parts: [{ type: "text", content: "hello" }],
      },
      {
        id: "msg_assistant",
        role: "assistant",
        metadata: {
          opencodeMessage: { cost: 0.25 },
        },
        parts: [
          { type: "thinking", content: "thinking", stepId: "part_reason" },
          { type: "text", content: "answer" },
          { type: "tool-call", id: "call_1", name: "read", state: "complete", output: "ok" },
        ],
      },
    ])
  })

  test("preserves @-mention agent parts through the round-trip projection", () => {
    const snapshot = opencodeConversationSnapshot({
      messages: [message("msg_user", "user")],
      parts: {
        msg_user: [
          agentPart("part_agent", "msg_user", "reviewer"),
          textPart("part_prompt", "msg_user", "@reviewer take a look"),
        ],
      },
    })

    // Part -> UIMessage keeps the agent mention (previously dropped: no
    // `type: "agent"` case existed in either projection direction).
    expect(snapshot[0]?.parts).toMatchObject([
      { type: "agent", name: "reviewer", source: { value: "@reviewer", start: 0, end: 9 } },
      { type: "text", content: "@reviewer take a look" },
    ])

    // UIMessage -> OpenCode Part restores the AgentPart intact so the timeline
    // renderer (session-ui) can highlight the mention span.
    const projected = opencodeConversationProjection(snapshot)
    expect(projected.parts.msg_user).toMatchObject([
      { id: "part_agent", type: "agent", name: "reviewer", messageID: "msg_user", source: { value: "@reviewer", start: 0, end: 9 } },
      { id: "part_prompt", type: "text", text: "@reviewer take a look" },
    ])
  })

  test("reconstructs an AgentPart from carried name/source when no opencodePart is stored", () => {
    // The path a freshly-composed optimistic user message takes before the
    // server echoes it: the agent part carries name/source but has no
    // metadata.opencodePart, so the projection rebuilds the AgentPart from
    // the carried fields (branch at opencode-conversation.ts:~387).
    const optimistic: UIMessage = {
      id: "msg_optimistic",
      role: "user",
      parts: [
        {
          type: "agent",
          name: "reviewer",
          source: { value: "@reviewer", start: 0, end: 9 },
        } as MessagePart,
      ],
    }

    const projected = opencodeConversationProjection([optimistic])
    expect(projected.parts.msg_optimistic).toEqual([
      {
        id: "msg_optimistic:agent",
        sessionID: "",
        messageID: "msg_optimistic",
        type: "agent",
        name: "reviewer",
        source: { value: "@reviewer", start: 0, end: 9 },
      },
    ])
  })

  test("applies a streamed agent part through message.part.updated", () => {
    const handle = chat(opencodeConversationSnapshot({
      messages: [message("msg_user", "user")],
      parts: { msg_user: [textPart("part_prompt", "msg_user", "hey")] },
    }))

    expect(applyOpencodeConversationEvent(handle, event("message.part.updated", {
      part: agentPart("part_agent", "msg_user", "planner"),
    }))).toBe(true)
    expect(handle.messages()[0]?.parts).toMatchObject([
      { type: "text", content: "hey" },
      { type: "agent", name: "planner" },
    ])
  })

  test("applies message and part events through chat setMessages", () => {
    const handle = chat()

    expect(applyOpencodeConversationEvent(handle, event("message.updated", {
      info: message("msg_assistant"),
    }))).toBe(true)
    expect(applyOpencodeConversationEvent(handle, event("message.part.updated", {
      part: textPart("part_text", "msg_assistant", "hel"),
    }))).toBe(true)
    expect(applyOpencodeConversationEvent(handle, event("message.part.delta", {
      messageID: "msg_assistant",
      partID: "part_text",
      delta: "lo",
    }))).toBe(true)

    expect(handle.messages()).toMatchObject([{
      id: "msg_assistant",
      parts: [{ type: "text", content: "hello" }],
    }])
    expect(handle.written).toHaveLength(3)
  })

  test("a settled assistant message rejects late streamed parts under a different part id", () => {
    // Ordering raced in CI: the REST history refetch lands the completed
    // assistant row (persisted part id `<msgId>_text`) BEFORE the delayed SSE
    // batch delivers the compat projection's streamed part (synthesized id
    // `000000_<msgId>-text`) for the same reply. The late part must not append
    // a second copy of the text.
    const settled = { ...message("msg_assistant"), time: { created: 2, completed: 3 } } as Message
    const handle = chat(opencodeConversationSnapshot({
      messages: [settled],
      parts: { msg_assistant: [textPart("msg_assistant_text", "msg_assistant", "hello")] },
    }))

    expect(applyOpencodeConversationEvent(handle, event("message.part.updated", {
      part: textPart("000000_msg_assistant-text", "msg_assistant", ""),
    }))).toBe(false)
    expect(applyOpencodeConversationEvent(handle, event("message.part.delta", {
      messageID: "msg_assistant",
      partID: "000000_msg_assistant-text",
      delta: "hello",
    }))).toBe(false)
    expect(handle.messages()[0]?.parts).toMatchObject([{ type: "text", content: "hello" }])

    // Updates to a part the settled message already has still apply.
    expect(applyOpencodeConversationEvent(handle, event("message.part.updated", {
      part: textPart("msg_assistant_text", "msg_assistant", "hello!"),
    }))).toBe(true)
    expect(handle.messages()[0]?.parts).toMatchObject([{ type: "text", content: "hello!" }])
  })

  test("snapshot merge treats a settled assistant message's fetched parts as authoritative", () => {
    // Reverse ordering of the race above: a streamed part attached first, then
    // the completed REST row hydrates. The persisted part set wins; the
    // chat-only streamed twin is dropped instead of re-appended.
    const settled = { ...message("msg_assistant"), time: { created: 2, completed: 3 } } as Message
    const live = opencodeConversationSnapshot({
      messages: [message("msg_assistant")],
      parts: { msg_assistant: [textPart("000000_msg_assistant-text", "msg_assistant", "hello")] },
    })
    const fetched = opencodeConversationSnapshot({
      messages: [settled],
      parts: { msg_assistant: [textPart("msg_assistant_text", "msg_assistant", "hello")] },
    })

    expect(mergeConversationSnapshot(live, fetched)).toMatchObject([{
      id: "msg_assistant",
      parts: [{ type: "text", content: "hello" }],
    }])
    expect(mergeConversationSnapshot(live, fetched)[0]?.parts).toHaveLength(1)
  })

  test("snapshot merge preserves chat-owned live deltas for matching parts", () => {
    const snapshot = opencodeConversationSnapshot({
      messages: [message("msg_assistant")],
      parts: {
        msg_assistant: [textPart("part_text", "msg_assistant", "hel")],
      },
    })
    const handle = chat(snapshot)
    applyOpencodeConversationEvent(handle, event("message.part.delta", {
      messageID: "msg_assistant",
      partID: "part_text",
      delta: "lo",
    }))

    expect(mergeConversationSnapshot(handle.messages(), snapshot)).toMatchObject([{
      id: "msg_assistant",
      parts: [{ type: "text", content: "hello" }],
    }])
  })

  test("snapshot merge adds fetched history without dropping live chat messages", () => {
    const live = opencodeConversationSnapshot({
      messages: [message("msg_live")],
      parts: {
        msg_live: [textPart("part_live", "msg_live", "live")],
      },
    })
    const history = opencodeConversationSnapshot({
      messages: [message("msg_old", "user")],
      parts: {
        msg_old: [textPart("part_old", "msg_old", "old")],
      },
    })

    expect(mergeConversationSnapshot(live, history).map((item) => item.id)).toEqual(["msg_live", "msg_old"].sort())
  })

  test("removes messages and parts from chat state", () => {
    const handle = chat(opencodeConversationSnapshot({
      messages: [message("msg_assistant")],
      parts: {
        msg_assistant: [
          textPart("part_text", "msg_assistant", "answer"),
          toolPart("part_tool", "msg_assistant"),
        ],
      },
    }))

    expect(applyOpencodeConversationEvent(handle, event("message.part.removed", {
      messageID: "msg_assistant",
      partID: "part_tool",
    }))).toBe(true)
    expect(handle.messages()[0]?.parts).toMatchObject([{ type: "text", content: "answer" }])

    expect(applyOpencodeConversationEvent(handle, event("message.removed", {
      messageID: "msg_assistant",
    }))).toBe(true)
    expect(handle.messages()).toEqual([])
  })

  test("projects chat messages back to OpenCode-shaped messages and live parts", () => {
    const handle = chat(opencodeConversationSnapshot({
      messages: [message("msg_user", "user"), message("msg_assistant")],
      parts: {
        msg_user: [textPart("part_prompt", "msg_user", "hello")],
        msg_assistant: [textPart("part_text", "msg_assistant", "hel")],
      },
    }))
    applyOpencodeConversationEvent(handle, event("message.part.delta", {
      messageID: "msg_assistant",
      partID: "part_text",
      delta: "lo",
    }))

    expect(opencodeConversationProjection(handle.messages())).toMatchObject({
      messages: [
        { id: "msg_user", role: "user", system: "system prompt" },
        { id: "msg_assistant", role: "assistant", tokens: { input: 10 }, cost: 0.25 },
      ],
      parts: {
        msg_assistant: [{ id: "part_text", text: "hello" }],
        msg_user: [{ id: "part_prompt", text: "hello" }],
      },
    })
  })
})

describe("opencodeConversationProjection caching", () => {
  test("reuses projected output for messages whose reference is unchanged", () => {
    const snapshot = opencodeConversationSnapshot({
      messages: [message("msg_1"), message("msg_2")],
      parts: {
        msg_1: [textPart("part_1", "msg_1", "hello")],
        msg_2: [textPart("part_2", "msg_2", "world")],
      },
    })

    const first = opencodeConversationProjection(snapshot)

    // Simulate a streaming update: only msg_2 gets a new object reference, the
    // way the event-apply path replaces just the changed index.
    const updated = snapshot.map((m, index) => (index === 1 ? { ...m, parts: [...m.parts] } : m))
    const second = opencodeConversationProjection(updated)

    // Unchanged message reuses its projected Message + parts by reference (no
    // re-projection), so a token append is O(changed), not O(all messages).
    expect(second.messages[0]).toBe(first.messages[0])
    expect(second.parts.msg_1).toBe(first.parts.msg_1)

    // Changed message is re-projected with a fresh reference and correct content.
    expect(second.messages[1]).not.toBe(first.messages[1])
    expect(second.parts.msg_2).not.toBe(first.parts.msg_2)
    expect(second.messages[1]).toMatchObject({ id: "msg_2" })
    expect(second.parts.msg_2).toMatchObject([{ id: "part_2", text: "world" }])
  })
})
