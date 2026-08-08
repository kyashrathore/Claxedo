import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import {
  OPENCODE_COMPATIBILITY_EXCEPTIONS,
  legacyRuntimeEventFromOpencodeCompat,
  opencodeCompatProjectionOwner,
  opencodeLegacyOwnsCompatProjection,
  runtimeOwnsOpencodeCompatProjection,
} from "./index"

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(full)
    return full
  })
}

describe("OpenCode compatibility ownership", () => {
  test("declares legacy OpenCode sessions as compat-owned and runtime sessions as runtime-owned", () => {
    expect(opencodeCompatProjectionOwner({ sessionId: "ses_1" })).toBe("opencode-legacy")
    expect(opencodeLegacyOwnsCompatProjection({ sessionId: "ses_1" })).toBe(true)
    expect(runtimeOwnsOpencodeCompatProjection({ sessionId: "ses_1" })).toBe(false)

    expect(opencodeCompatProjectionOwner({ sessionId: "runtime-session-1" })).toBe("runtime")
    expect(opencodeLegacyOwnsCompatProjection({ sessionId: "runtime-session-1" })).toBe(false)
    expect(runtimeOwnsOpencodeCompatProjection({ sessionId: "runtime-session-1" })).toBe(true)
  })

  test("records the legacy conversion exception with owner, replacement, removal, and tests", () => {
    expect(OPENCODE_COMPATIBILITY_EXCEPTIONS).toHaveLength(1)
    expect(OPENCODE_COMPATIBILITY_EXCEPTIONS[0]).toMatchObject({
      owner: expect.any(String),
      reason: expect.any(String),
      module: "packages/agent-event-runtime/src/projections/opencode-compat/runtime-event.ts",
      symbol: "legacyRuntimeEventFromOpencodeCompat",
      canonicalReplacement: expect.any(String),
      removalCondition: expect.any(String),
    })
    expect(OPENCODE_COMPATIBILITY_EXCEPTIONS[0].tests.length).toBeGreaterThan(0)
    expect(OPENCODE_COMPATIBILITY_EXCEPTIONS[0].productionUseAllowlist.length).toBeGreaterThan(0)
  })

  test("keeps legacy compat-to-runtime conversion fenced to the declared production owner", () => {
    const repo = path.resolve(import.meta.dirname, "../../../../..")
    const hits = walk(path.join(repo, "packages"))
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .filter((file) => file.includes(`${path.sep}src${path.sep}`))
      .filter((file) => fs.readFileSync(file, "utf-8").includes("legacyRuntimeEventFromOpencodeCompat"))
      .map((file) => path.relative(repo, file))
      .sort()

    expect(hits).toEqual([...OPENCODE_COMPATIBILITY_EXCEPTIONS[0].productionUseAllowlist].sort())
  })
})

describe("legacyRuntimeEventFromOpencodeCompat", () => {
  test("preserves exact usage observations without replacing unknown categories with zero", () => {
    expect(legacyRuntimeEventFromOpencodeCompat({
      type: "session.usage",
      properties: {
        sessionID: "session-1",
        messageID: "assistant-1",
        contextSize: 10_000,
        contextUsed: 20,
        observation: {
          kind: "cumulative",
          tokens: {
            input: 10,
            output: 5,
            reasoning: null,
            cache: { read: 5, write: null },
          },
        },
      },
    }, new Map())?.payload).toEqual({
      type: "usage",
      contextSize: 10_000,
      contextUsed: 20,
      observation: {
        kind: "cumulative",
        tokens: {
          input: 10,
          output: 5,
          reasoning: null,
          cache: { read: 5, write: null },
        },
      },
    })
  })

  test("uses remembered part type to map SDK text-field reasoning deltas to thinking deltas", () => {
    const content = new Map<string, string>()

    expect(legacyRuntimeEventFromOpencodeCompat({
      type: "message.part.updated",
      properties: {
        sessionID: "session-1",
        time: 100,
        part: {
          id: "part-1",
          sessionID: "session-1",
          messageID: "message-1",
          type: "reasoning",
          text: "",
          time: { start: 100 },
        },
      },
    }, content)).toBeUndefined()

    expect(legacyRuntimeEventFromOpencodeCompat({
      type: "message.part.delta",
      properties: {
        sessionID: "session-1",
        messageID: "message-1",
        partID: "part-1",
        field: "text",
        delta: "thinking",
      },
    }, content)?.payload).toEqual({
      type: "thinking-delta",
      delta: "thinking",
    })
  })
})
