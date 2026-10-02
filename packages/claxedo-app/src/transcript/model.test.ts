import { expect, test } from "bun:test"
import { messageAuthor } from "./model"

test("stored agent-authored user rows retain their canonical author", () => {
  const author = { id: "harness:claude", name: "Claude Code", kind: "agent" } as const
  expect(messageAuthor({ role: "user", claxedo: { author } })).toEqual(author)
})

test("human authors and unattributed prompts stay human even with agent-like text", () => {
  const author = { id: "human", name: "User", kind: "human" }
  expect(messageAuthor({ role: "user", claxedo: { author } })?.kind).toBe("human")
  expect(messageAuthor({ role: "user", claxedo: { text: "This agent's report was delivered" } })).toBeUndefined()
})

test("assistant rows and incomplete or unknown authors cannot become agent events", () => {
  const author = { id: "harness:claude", name: "Claude Code", kind: "agent" }
  expect(messageAuthor({ role: "assistant", claxedo: { author } })).toBeUndefined()
  expect(messageAuthor({ role: "user", claxedo: { author: { ...author, name: undefined } } })).toBeUndefined()
  expect(messageAuthor({ role: "user", claxedo: { author: { ...author, kind: "peer" } } })).toBeUndefined()
})
