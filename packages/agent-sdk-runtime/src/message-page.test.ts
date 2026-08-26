import { describe, expect, test } from "bun:test"
import {
  LATEST_SURFACE_MAX_OPTIONAL_INFO_VALUE_BYTES,
  LATEST_SURFACE_MAX_TEXT_BYTES,
  LATEST_SURFACE_MAX_TEXT_PART_BYTES,
  LATEST_SURFACE_MAX_TEXT_PARTS,
  projectLatestSurfaceMessage,
  projectLatestSurfaceMessages,
} from "./message-page"

describe("latest-surface first-paint projection", () => {
  test("removes only nonvisual user envelope fields and keeps complete text parts", () => {
    const text = { id: "text", type: "text", text: "complete prompt", metadata: { canonical: true } }
    const message = {
      info: {
        id: "user",
        sessionID: "session",
        role: "user",
        time: { created: 1 },
        agent: "build",
        model: { providerID: "provider", modelID: "model" },
        format: { type: "text" },
        summary: { title: "large summary" },
        system: "large system prompt",
        tools: { read: true },
      },
      parts: [text, { id: "file", type: "file", url: "data:large" }],
      harnessPayload: { preserved: true },
    }

    expect(projectLatestSurfaceMessage(message)).toEqual({
      info: {
        id: "user",
        sessionID: "session",
        role: "user",
        time: { created: 1 },
        agent: "build",
        model: { providerID: "provider", modelID: "model" },
        format: { type: "text" },
      },
      parts: [text],
      harnessPayload: { preserved: true },
    } as unknown as typeof message)
    expect(message.info.system).toBe("large system prompt")
    expect(message.parts).toHaveLength(2)
  })

  test("keeps assistant info and complete text while omitting non-text parts", () => {
    const info = {
      id: "assistant",
      role: "assistant",
      parentID: "user",
      time: { created: 2, completed: 3 },
      error: { name: "preserved" },
    }
    const text = { id: "text", type: "text", text: "complete final reply" }

    expect(projectLatestSurfaceMessage({
      info,
      parts: [
        { id: "reasoning", type: "reasoning", text: "large reasoning" },
        { id: "tool", type: "tool", state: { output: "large tool output" } },
        text,
      ],
    })).toEqual({ info, parts: [text] })
  })

  test("omits an oversized user text as a whole while prioritizing the final assistant reply", () => {
    const oversized = "u".repeat(LATEST_SURFACE_MAX_TEXT_PART_BYTES + 1)
    const messages: Array<{ info: Record<string, unknown>; parts: Array<{ id: string; type: string; text: string }> }> = [
      {
        info: { id: "user", role: "user", time: { created: 1 } },
        parts: [{ id: "user-text", type: "text", text: oversized }],
      },
      {
        info: { id: "assistant", role: "assistant", parentID: "user", time: { created: 2, completed: 3 } },
        parts: [{ id: "assistant-text", type: "text", text: "complete final reply" }],
      },
    ]

    expect(projectLatestSurfaceMessages(messages)).toEqual([
      { info: messages[0]!.info, parts: [] },
      { info: messages[1]!.info, parts: [messages[1]!.parts[0]] },
    ])
    expect(messages[0]!.parts[0]!.text).toBe(oversized)
  })

  test("omits an oversized assistant text without truncating it", () => {
    const oversized = "a".repeat(LATEST_SURFACE_MAX_TEXT_PART_BYTES + 1)
    const message = {
      info: { id: "assistant", role: "assistant", parentID: "user", time: { created: 2, completed: 3 } },
      parts: [{ id: "assistant-text", type: "text", text: oversized }],
    }

    expect(projectLatestSurfaceMessage(message)).toEqual({ info: message.info, parts: [] })
    expect(message.parts[0]!.text).toBe(oversized)
  })

  test("measures text in UTF-8 bytes and preserves the measured 25,115-byte corpus maximum", () => {
    const measuredCorpusMaximum = "a".repeat(25_115)
    const overByteLimit = "é".repeat(Math.floor(LATEST_SURFACE_MAX_TEXT_PART_BYTES / 2) + 1)
    const message = {
      info: { id: "assistant", role: "assistant", parentID: "user", time: { created: 2, completed: 3 } },
      parts: [
        { id: "measured", type: "text", text: measuredCorpusMaximum },
        { id: "over", type: "text", text: overByteLimit },
      ],
    }

    expect(new TextEncoder().encode("é")).toHaveLength(2)
    expect(new TextEncoder().encode(measuredCorpusMaximum)).toHaveLength(25_115)
    expect(projectLatestSurfaceMessage(message)?.parts).toEqual([message.parts[0]])
  })

  test("omits an oversized optional assistant error value but preserves required envelope fields", () => {
    const error = { name: "ProviderError", data: { body: "e".repeat(LATEST_SURFACE_MAX_OPTIONAL_INFO_VALUE_BYTES) } }
    const message: { info: Record<string, unknown>; parts: Array<{ id: string; type: string; text: string }> } = {
      info: {
        id: "assistant",
        role: "assistant",
        sessionID: "session",
        parentID: "user",
        time: { created: 2, completed: 3 },
        error,
      },
      parts: [{ id: "assistant-text", type: "text", text: "complete final reply" }],
    }

    expect(projectLatestSurfaceMessage(message)).toEqual({
      info: {
        id: "assistant",
        role: "assistant",
        sessionID: "session",
        parentID: "user",
        time: { created: 2, completed: 3 },
      },
      parts: message.parts,
    })
    expect(message.info.error).toBe(error)
  })

  test("bounds many small parts, prioritizes the final message, and restores canonical order", () => {
    const chunk = "x".repeat(Math.floor(LATEST_SURFACE_MAX_TEXT_BYTES / LATEST_SURFACE_MAX_TEXT_PARTS) - 128)
    const user = {
      info: { id: "user", role: "user", time: { created: 1 } },
      parts: Array.from({ length: 4 }, (_, index) => ({ id: `user-${index}`, type: "text", text: chunk })),
    }
    const assistant = {
      info: { id: "assistant", role: "assistant", parentID: "user", time: { created: 2, completed: 3 } },
      parts: Array.from({ length: 20 }, (_, index) => ({ id: `assistant-${index}`, type: "text", text: chunk })),
    }

    const projected = projectLatestSurfaceMessages([user, assistant])
    expect(projected[0]!.parts).toEqual([])
    expect(projected[1]!.parts).toHaveLength(LATEST_SURFACE_MAX_TEXT_PARTS)
    expect(projected[1]!.parts.map((part) => part.id)).toEqual(
      Array.from({ length: LATEST_SURFACE_MAX_TEXT_PARTS }, (_, index) => `assistant-${index + 4}`),
    )
  })

  test("omits the whole surface when an unmodified envelope cannot fit", () => {
    const messages = [
      {
        info: { id: "user", role: "user", time: { created: 1 } },
        parts: [{ id: "user-text", type: "text", text: "prompt" }],
      },
      {
        info: {
          id: "assistant",
          role: "assistant",
          parentID: "user",
          time: { created: 2, completed: 3 },
          structured: { canonical: "s".repeat(20 * 1024) },
        },
        parts: [{ id: "assistant-text", type: "text", text: "reply" }],
      },
    ]

    expect(projectLatestSurfaceMessages(messages)).toEqual([])
    expect((messages[1]!.info.structured as { canonical: string }).canonical).toHaveLength(20 * 1024)
  })
})
