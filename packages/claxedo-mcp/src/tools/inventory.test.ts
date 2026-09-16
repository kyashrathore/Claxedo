import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { SessionAccessOperation } from "@claxedo/workspace-runtime/client"
import type { ClaxedoMcpClient } from "../client/contract"
import type { McpAudience, McpCredential, McpToolAccess, McpToolContext } from "../context"
import { createToolRegistry } from "./registry"
import { CLAXEDO_MCP_TOOL_GROUPS, claxedoMcpToolGroupInventory } from "./index"
import {
  MCP_OPERATIONS_SERVED_ELSEWHERE,
  MCP_OPERATIONS_WITHOUT_TOOLS,
  MCP_TOOL_OPERATIONS,
  operationsWriteClass,
  RUNTIME_OPERATIONS,
  runtimeToolAccess,
} from "./inventory"

const client = {
  deployment: "loopback",
  runtime: async () => async () => new Response(null, { status: 204 }),
  resolveTarget: async () => ({ kind: "loopback" as const, baseUrl: "", headers: {} }),
  server: () => Promise.reject(new Error("the surface is registered, never called, in this test")),
  workspaces: async () => [],
} satisfies ClaxedoMcpClient

const runtimeCredential: McpCredential = {
  kind: "runtime",
  runtimeId: "rt_1",
  workspaceId: "ws_1",
  crossMachineWrites: false,
  readOnly: false,
}

const userCredential = (readOnly = false): McpCredential => ({
  kind: "user",
  actorId: "actor_1",
  clientId: "cli",
  scopes: new Set(["read", "act", "approve", "admin"] as const),
  readOnly,
})

/** Registers every group against one credential and reports what it declared and what it listed. */
function surface(credential: McpCredential, tasks?: ClaxedoMcpClient["tasks"]) {
  const ctx: McpToolContext = { credential, client: { ...client, ...(tasks ? { tasks } : {}) }, audit: () => undefined }
  const registry = createToolRegistry(new McpServer({ name: "claxedo", version: "0.0.0" }), ctx)
  for (const group of CLAXEDO_MCP_TOOL_GROUPS) group.register(registry)
  return { declared: registry.declared, listed: [...registry.listed].toSorted() }
}

const operations = () => [...RUNTIME_OPERATIONS.keys()].toSorted()

function uncovered(covered: ReadonlySet<string>, excluded: ReadonlySet<string>) {
  return operations().filter((operation) => !covered.has(operation) && !excluded.has(operation))
}

const coveredByTools = () =>
  new Set<string>([...Object.values(MCP_TOOL_OPERATIONS).flat(), ...Object.keys(MCP_OPERATIONS_SERVED_ELSEWHERE)])

const excluded = () => new Set<string>(Object.keys(MCP_OPERATIONS_WITHOUT_TOOLS))

describe("the runtime route inventory", () => {
  test("is read from the runtime's own table, write class included", () => {
    expect(RUNTIME_OPERATIONS.get("prompt")).toEqual({
      operation: "prompt",
      write: true,
      routes: ["POST /session/:id/message", "POST /session/:id/prompt_async"],
    })
    expect(RUNTIME_OPERATIONS.get("session_list")).toMatchObject({ write: false })
    // `GET /agent` is a `workspace` decision, so it contributes no operation.
    expect([...RUNTIME_OPERATIONS.values()].flatMap((entry) => entry.routes)).not.toContain("GET /agent")
  })
})

describe("tool coverage", () => {
  test("every runtime operation has a tool or a pinned reason for having none", () => {
    expect(uncovered(coveredByTools(), excluded())).toEqual([])
  })

  test("an operation with no tool and no pinned reason is reported", () => {
    expect(uncovered(new Set(), new Set())).toEqual(operations())
    expect(uncovered(coveredByTools(), new Set())).toContain("shell")
    expect(uncovered(new Set(), excluded())).toContain("prompt")
  })

  test("no operation is both covered and excluded", () => {
    const covered = coveredByTools()
    expect([...excluded()].filter((operation) => covered.has(operation))).toEqual([])
  })

  test("every excluded operation is one the runtime actually has", () => {
    const known = new Set<string>(operations())
    expect([...excluded(), ...Object.keys(MCP_OPERATIONS_SERVED_ELSEWHERE)].filter((operation) => !known.has(operation))).toEqual([])
  })

  test("a tool naming an operation the runtime does not have is refused", () => {
    expect(() => operationsWriteClass("session_send", ["prompt"])).not.toThrow()
    // A real member of `SessionAccessOperation` that no session-core route uses.
    expect(() => operationsWriteClass("checkpoints", ["checkpoint_write"])).toThrow(/route inventory does not have/)
    expect(() => operationsWriteClass("nothing", [])).toThrow(/claims no runtime operation/)
  })

  test("read-only is the runtime's write class, not the tool's opinion", () => {
    const gating = { audiences: ["user"] as readonly McpAudience[], scope: "act" } as const
    expect(runtimeToolAccess("session_send", gating).write).toBe(true)
    expect(runtimeToolAccess("session_transcript", { ...gating, scope: "read" }).write).toBe(false)
    // `session_get` reads two operations; neither is a write, and one write would make the tool one.
    expect(runtimeToolAccess("session_get", { ...gating, scope: "read" }).write).toBe(false)
    expect(runtimeToolAccess("session_delete", { ...gating, scope: "admin", destructive: true })).toEqual({
      audiences: ["user"],
      write: true,
      scope: "admin",
      destructive: true,
    })
  })
})

describe("the registered surface", () => {
  test("registers every tool the coverage table names", () => {
    const declared = surface(userCredential()).declared
    const runtimeDeclared = surface(runtimeCredential).declared
    for (const name of Object.keys(MCP_TOOL_OPERATIONS)) {
      expect(declared.has(name) || runtimeDeclared.has(name)).toBe(true)
    }
  })

  test("registers every tool an operation is delegated to", () => {
    const declared = new Set([...surface(userCredential()).declared.keys(), ...surface(runtimeCredential).declared.keys()])
    for (const [operation, owners] of Object.entries(MCP_OPERATIONS_SERVED_ELSEWHERE)) {
      for (const owner of owners) expect({ operation, owner, registered: declared.has(owner) }).toEqual({ operation, owner, registered: true })
    }
  })

  test("lists the inside-session set for a runtime credential", () => {
    expect(surface(runtimeCredential).listed).toEqual([
      "create_subagent",
      "documents_list",
      "documents_open",
      "process_logs",
      "process_start",
      "process_stop",
      "processes",
      "question_reply",
      "session_abort",
      "session_create",
      "session_get",
      "session_send",
      "session_transcript",
      "sessions_list",
      "subagent_cancel",
      "subagent_capabilities",
      "subagent_list",
      "subagent_status",
    ])
  })

  test("adds the Tasks tools the grant covers, and nothing else", () => {
    const granted = surface(runtimeCredential, { fetch: async () => new Response(null, { status: 204 }), operations: ["read", "create", "start"] })
    const without = new Set(surface(runtimeCredential).listed)
    expect(granted.listed.filter((name) => !without.has(name))).toEqual(["task_create", "task_edit", "task_get", "task_list", "task_start"])
  })

  test("lists the outside-in set for a user credential", () => {
    expect(surface(userCredential()).listed).toEqual([
      "documents_list",
      "documents_open",
      "permission_reply",
      "process_logs",
      "process_start",
      "process_stop",
      "processes",
      "question_reject",
      "question_reply",
      "session_abort",
      "session_changes",
      "session_create",
      "session_delete",
      "session_get",
      "session_handoff",
      "session_rename",
      "session_send",
      "session_transcript",
      "sessions_board",
      "sessions_list",
      "wait_for_attention",
      "workspace_checkpoint",
      "workspace_lifecycle",
      "workspace_restore",
      "workspace_status",
      "workspaces_list",
    ])
  })

  test("a read-only credential is listed no tool the runtime calls a write", () => {
    const { declared, listed } = surface(userCredential(true))
    const writes = [...declared].flatMap(([name, access]) => (access.write ? [name] : []))
    expect(writes.length).toBeGreaterThan(0)
    expect(listed.filter((name) => writes.includes(name))).toEqual([])
    expect(listed).toEqual([
      "documents_list",
      "process_logs",
      "processes",
      "session_changes",
      "session_get",
      "session_transcript",
      "sessions_board",
      "sessions_list",
      "wait_for_attention",
      "workspace_status",
      "workspaces_list",
    ])
  })

  test("the destructive set is human-only, admin-scoped and annotated", () => {
    const destructive = [...surface(userCredential()).declared]
      .flatMap(([name, access]) => (access.destructive ? [[name, access] as const] : []))
      .toSorted(([left], [right]) => left.localeCompare(right))
    expect(destructive.map(([name]) => name)).toEqual(["session_delete", "workspace_lifecycle", "workspace_restore"])
    for (const [name, access] of destructive) {
      expect({ name, ...(access as McpToolAccess) }).toEqual({ name, audiences: ["user"], write: true, scope: "admin", destructive: true })
    }
  })
})

/** The union member the throw test uses must stay a real operation the routes do not name. */
const CHECKPOINT_WRITE: SessionAccessOperation = "checkpoint_write"
test("checkpoint_write is an operation the session-core routes never name", () => {
  expect(RUNTIME_OPERATIONS.has(CHECKPOINT_WRITE)).toBe(false)
})

describe("the tool names the catalog publishes", () => {
  test("are exactly the names a real mount registers, group by group", () => {
    const declared = surface(userCredential()).declared
    const published = claxedoMcpToolGroupInventory()

    // The catalog derives its names by running each registration against a
    // sink with no server, no context and no credential behind it. This is the
    // assertion that the sink sees what a real registry sees: a name reached
    // through a constant, or registered under a branch the sink does not
    // satisfy, would be published as absent and consented to as absent while
    // the mount served it.
    expect(published.flatMap((group) => group.tools).toSorted()).toEqual([...declared.keys()].toSorted())
    expect(published.find((group) => group.id === "attention")?.tools).toContain("permission_reply")
    expect(new Set(published.flatMap((group) => group.tools)).size).toBe(declared.size)
  })

  test("declare a reach, and only the two that leave the runtime say so", () => {
    const published = claxedoMcpToolGroupInventory()
    // What a project inherits is computed from these, so a group that reaches
    // past the session and says "runtime" is granted to every project that has
    // decided nothing. The list is short on purpose: adding to it is the
    // decision, and this is where it gets read.
    expect(published.filter((group) => group.reach === "account").map((group) => group.id)).toEqual(["tasks"])
    expect(published.filter((group) => typeof group.reach === "object").map((group) => group.id)).toEqual(["documents"])
    expect(published.filter((group) => group.reach === "runtime").map((group) => group.id)).toEqual([
      "attention",
      "processes",
      "review",
      "sessions",
      "subagents",
      "workspaces",
    ])
  })
})

describe("the transcript's first-party roster", () => {
  // Read as text, not imported: session-ui is a UI package this server package
  // must not resolve, and its module pulls a .tsx type import this tsconfig cannot compile.
  test("names exactly the tools the groups register, so a renamed or added tool cannot render as a generic row", () => {
    const source = readFileSync(new URL("../../../session-ui/src/components/claxedo-tool-view.ts", import.meta.url), "utf8")
    const block = source.split("export const CLAXEDO_TOOL_TITLE_KEYS = {")[1]?.split("} as const")[0] ?? ""
    const roster = [...block.matchAll(/^\s*([a-z_]+):\s*"ui\.claxedoTool\.[a-z_]+",$/gm)].map((match) => match[1]).sort()
    const registered = claxedoMcpToolGroupInventory().flatMap((group) => group.tools).sort()
    expect(roster.length).toBeGreaterThan(0)
    expect(roster).toEqual(registered)
  })
})
