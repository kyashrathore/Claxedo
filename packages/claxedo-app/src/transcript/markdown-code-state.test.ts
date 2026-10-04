/// <reference types="bun" />
import { expect, test } from "bun:test"
import { sameRenderedCode, shouldResetCodeTokens, type RenderedCodeState } from "./markdown-code-state"
import type { MarkdownToken } from "./markdown-worker-protocol"

const drawn: RenderedCodeState = {
  render: "tokens",
  language: "ts",
  generation: 2,
  stableCount: 1,
  unstable: [["const", "color:red"], [" answer", ""]],
  raw: "const answer",
}

test("a code block drawn from equal tokens is unchanged, and any difference in what it drew is a change", () => {
  expect(sameRenderedCode(drawn, { ...drawn, unstable: drawn.unstable.map((token) => [...token] as MarkdownToken) })).toBe(true)
  expect(sameRenderedCode(undefined, drawn)).toBe(false)
  const changes: Partial<RenderedCodeState>[] = [
    { render: "plain" },
    { language: "js" },
    { generation: 3 },
    { stableCount: 2 },
    { raw: "const answer =" },
    { unstable: [["const", "color:blue"], [" answer", ""]] },
    { unstable: [["const", "color:red"]] },
  ]
  for (const change of changes) expect(sameRenderedCode(drawn, { ...drawn, ...change })).toBe(false)
})

test("a code block last drawn as plain text draws its tokens again from the start", () => {
  expect(shouldResetCodeTokens({ ...drawn, render: "plain" }, drawn)).toBe(true)
  expect(shouldResetCodeTokens(drawn, drawn)).toBe(false)
})
