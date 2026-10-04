import { expect, test } from "bun:test"
import { grantIdentity } from "./grant-identity"

test("a grant identity is a stable digest that carries none of the request", () => {
  const request = { tool: "Write", input: { file_path: "/work/note.txt", content: "APPROVED-FILE-CONTENT" } }
  const identity = grantIdentity(request)
  expect(identity).toMatch(/^[0-9a-f]{64}$/)
  expect(identity).not.toContain("APPROVED")
  expect(grantIdentity(structuredClone(request))).toBe(identity)
  expect(grantIdentity({ ...request, input: { ...request.input, content: "CHANGED-FILE-CONTENT" } })).not.toBe(identity)
})
