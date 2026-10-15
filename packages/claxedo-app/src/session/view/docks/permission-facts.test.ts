import { expect, test } from "bun:test"
import type { AgentPermission } from "@claxedo/agent-runtime-contract"
import { permissionFacts } from "./permission-facts"

function claudeAsk(tool: string, input: Record<string, unknown>, description = ""): AgentPermission {
  return {
    id: "perm-1", sessionID: "ses-1", permission: tool, title: tool, patterns: [], always: [],
    metadata: { input, description, turnId: "turn-1" },
    options: [{ id: "allow_once", label: "Allow once" }, { id: "deny", label: "Deny" }],
  }
}

test("a Claude Code Bash ask names the tool and shows the command it will run", () => {
  const facts = permissionFacts(claudeAsk("Bash", { command: "git push --force origin main", description: "Force-push main" }))
  expect(facts.tool).toBe("Bash")
  expect(facts.command).toBe("git push --force origin main")
  expect(facts.details).toContain("Force-push main")
})

test("a Claude Code edit ask shows the file it writes and the whole change", () => {
  const facts = permissionFacts(claudeAsk("Edit", { file_path: "/work/.env", old_string: "A=1", new_string: "A=2" },
    "Claude will have write access to /work"))
  expect(facts.tool).toBe("Edit")
  expect(facts.inputFields).toEqual([{ name: "file_path", value: "/work/.env" }])
  expect(facts.reason).toBe("Claude will have write access to /work")
  expect(JSON.parse(facts.details ?? "{}")).toEqual({ file_path: "/work/.env", old_string: "A=1", new_string: "A=2" })
})

test("an MCP tool ask with no known field still shows its full input", () => {
  const facts = permissionFacts(claudeAsk("mcp__claxedo__session_send", { sessionId: "ses-2", text: "rm -rf /" }))
  expect(facts.tool).toBe("mcp__claxedo__session_send")
  expect(facts.command).toBeUndefined()
  expect(facts.inputFields).toEqual([])
  expect(JSON.parse(facts.details ?? "{}")).toEqual({ sessionId: "ses-2", text: "rm -rf /" })
})

test("an empty description is not shown as a reason", () => {
  expect(permissionFacts(claudeAsk("Read", { file_path: "/work/a.ts" })).reason).toBeUndefined()
})

test("an ACP ask keeps its command, working directory and raw tool call", () => {
  const facts = permissionFacts({
    id: "perm-2", sessionID: "ses-1", permission: "execute", patterns: [], always: [],
    metadata: { command: "ls", reason: "List files", acpToolCall: { toolCallId: "t1", rawInput: { command: "ls", cwd: "/work" } } },
  })
  expect(facts).toMatchObject({ tool: "execute", command: "ls", reason: "List files", directory: "/work", inputFields: [] })
  expect(facts.details).toContain("\"toolCallId\": \"t1\"")
})
