import { expect, test } from "bun:test"
import { replayClaudePermissionUpdates, claudeGrantUpdates, sessionPermissionUpdates } from "./grants"

test("permission updates replay in order: add, replace, remove, and directories", () => {
  const rules = replayClaudePermissionUpdates([
    { type: "addRules", behavior: "allow", destination: "session", rules: [{ toolName: "Read" }] },
    { type: "addRules", behavior: "ask", destination: "session", rules: [{ toolName: "Bash", ruleContent: "git push *" }] },
    { type: "addRules", behavior: "allow", destination: "session", rules: [{ toolName: "Bash", ruleContent: "npm test" }, { toolName: "Read" }] },
    { type: "addRules", behavior: "deny", destination: "session", rules: [{ toolName: "WebFetch" }] },
    { type: "replaceRules", behavior: "ask", destination: "session", rules: [{ toolName: "Bash", ruleContent: "git push --force" }] },
    { type: "removeRules", behavior: "allow", destination: "session", rules: [{ toolName: "Read" }] },
    { type: "addDirectories", directories: ["/a", "/b"], destination: "session" },
    { type: "removeDirectories", directories: ["/a"], destination: "session" },
    { type: "setMode", mode: "acceptEdits", destination: "session" },
  ])
  expect(rules).toEqual({ allow: ["Bash(npm test)"], deny: ["WebFetch"], ask: ["Bash(git push --force)"], additionalDirectories: ["/b"] })
})

test("suggestions become session updates and malformed grants fail before launch", () => {
  expect(sessionPermissionUpdates(undefined)).toBeUndefined()
  expect(sessionPermissionUpdates([])).toBeUndefined()
  expect(sessionPermissionUpdates([{ type: "addDirectories", directories: ["/x"], destination: "userSettings" }]))
    .toEqual([{ type: "addDirectories", directories: ["/x"], destination: "session" }])
  expect(claudeGrantUpdates([JSON.stringify({ tool: "Bash", identity: {} })])).toEqual([])
  expect(() => claudeGrantUpdates(["{"])).toThrow("Invalid persisted Claude grant")
  expect(() => claudeGrantUpdates([JSON.stringify([1])])).toThrow("Invalid persisted Claude grant")
  expect(() => claudeGrantUpdates([JSON.stringify({ updates: [1] })])).toThrow("Invalid persisted Claude grant updates")
})

test("rule replacement preserves parenthesized contents and other behaviors", () => {
  expect(replayClaudePermissionUpdates([
    { type: "addRules", behavior: "allow", destination: "session", rules: [{ toolName: "Read" }, { toolName: "Bash", ruleContent: "old" }] },
    { type: "addRules", behavior: "deny", destination: "session", rules: [{ toolName: "Write" }] },
    { type: "addDirectories", destination: "session", directories: ["/old"] },
    { type: "replaceRules", behavior: "allow", destination: "session", rules: [{ toolName: "Bash", ruleContent: "echo (hello)" }, { toolName: "Read" }] },
    { type: "removeRules", behavior: "allow", destination: "session", rules: [{ toolName: "Read" }] },
    { type: "removeDirectories", destination: "session", directories: ["/old"] },
  ])).toEqual({ allow: ["Bash(echo (hello))"], deny: ["Write"], ask: [], additionalDirectories: [] })
})
