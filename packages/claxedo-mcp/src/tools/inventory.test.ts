import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { SessionAccessOperation } from "@claxedo/session-core"
import type { ClaxedoMcpClient } from "../client/contract"
import { assertToolAccess, type McpAudience, type McpCredential, type McpToolAccess, type McpToolContext } from "../context"
import type { McpToolGroup } from "../tool-group"
import { createToolRegistry } from "./registry"
import { CLAXEDO_MCP_TOOL_GROUPS, claxedoMcpToolGroupInventory } from "./index"
import {
  declaredToolAccess,
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
  services: {},
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
function surface(
  credential: McpCredential,
  grants: Partial<Pick<ClaxedoMcpClient, "services" | "appPlugins" | "ownerDriven">> = {},
  groups: readonly McpToolGroup[] = CLAXEDO_MCP_TOOL_GROUPS,
) {
  const ctx: McpToolContext = { credential, client: { ...client, ...grants, services: grants.services ?? client.services }, audit: () => undefined }
  const registry = createToolRegistry(new McpServer({ name: "claxedo", version: "0.0.0" }), ctx)
  for (const group of groups) group.register(registry)
  return { declared: registry.declared, listed: [...registry.listed].toSorted() }
}

/** A plugin's group whose two tools act through a service, one of them through an operation of it. */
const SERVICE_GROUP: McpToolGroup = {
  id: "fixture",
  reach: "account",
  register: (registry) => {
    const access = (operation?: string) =>
      declaredToolAccess({ audiences: ["runtime", "user"], write: false, scope: "read", service: { id: "fixture", label: "Fixture", ...(operation ? { operation } : {}) } })
    registry.tool("fixture_read", { description: "", inputSchema: {}, access: access() }, async () => ({ content: [] }))
    registry.tool("fixture_write", { description: "", inputSchema: {}, access: access("write") }, async () => ({ content: [] }))
  },
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
      routes: [
        "POST /session/:id/queue/:seq/:action",
        "POST /session/:id/message",
        "POST /session/:id/prompt_async",
      ],
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
    expect(uncovered(coveredByTools(), new Set())).toContain("fork")
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
      "question_reply",
      "session_cancel_turn",
      "session_create",
      "session_get",
      "session_send",
      "session_transcript",
      "sessions_list",
      "subagent_cancel",
      "subagent_capabilities",
      "subagent_list",
      "subagent_status",
      "ui_guide",
      "ui_show",
    ])
  })

  test("adds session_delete inside a session only while the composition answers that only its owner drove it", () => {
    const without = new Set(surface(runtimeCredential).listed)
    expect(surface(runtimeCredential, { ownerDriven: () => true }).listed.filter((name) => !without.has(name))).toEqual(["session_delete"])
  })

  test("lists a plugin group's service tools only while the client carries that service, and an operation's only while the grant names it", () => {
    const grant = (operations: readonly string[]) => ({ services: { fixture: { fetch: async () => new Response(null, { status: 204 }), operations } } })
    const fixture = (grants: Parameters<typeof surface>[1]) =>
      surface(runtimeCredential, grants, [SERVICE_GROUP]).listed
    expect(fixture({})).toEqual([])
    expect(fixture(grant([]))).toEqual(["fixture_read"])
    expect(fixture(grant(["write"]))).toEqual(["fixture_read", "fixture_write"])
  })

  test("refuses at the call what tools/list withheld, naming the service and the operation", () => {
    const access = { audiences: ["runtime", "user"] as const, write: false, scope: "read" as const, service: { id: "fixture", label: "Fixture", operation: "write" } }
    expect(() => assertToolAccess(runtimeCredential, "fixture_write", access, { services: {} }))
      .toThrow("fixture_write needs the Fixture service, which this Claxedo deployment does not serve")
    expect(() => assertToolAccess(runtimeCredential, "fixture_write", access, { services: { fixture: [] } }))
      .toThrow("fixture_write needs the write Fixture operation, which this session was not granted")
    expect(() => assertToolAccess(runtimeCredential, "fixture_write", access, { services: { fixture: ["write"] } })).not.toThrow()
  })

  test("adds the app plugin tools to a session granted authoring, and never to a person's account", () => {
    const appPlugins = {
      allowed: () => true,
      create: () => Promise.reject(new Error("registered, never called")),
      check: () => Promise.reject(new Error("registered, never called")),
      add: () => Promise.reject(new Error("registered, never called")),
    }
    const without = new Set(surface(runtimeCredential).listed)
    expect(surface(runtimeCredential, { appPlugins }).listed.filter((name) => !without.has(name)))
      .toEqual(["app_plugin_add", "app_plugin_check", "app_plugin_create", "app_plugin_guide"])
    expect(surface(userCredential(), { appPlugins }).listed).toEqual(surface(userCredential()).listed)
  })

  test("lists the outside-in set for a user credential", () => {
    expect(surface(userCredential()).listed).toEqual([
      "permission_reply",
      "question_reject",
      "question_reply",
      "session_cancel_turn",
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

  test("the destructive set is admin-scoped and annotated, and only session_delete reaches inside a session", () => {
    const destructive = [...surface(userCredential()).declared]
      .flatMap(([name, access]) => (access.destructive ? [[name, access] as const] : []))
      .toSorted(([left], [right]) => left.localeCompare(right))
    expect(destructive.map(([name]) => name)).toEqual(["session_delete", "workspace_lifecycle", "workspace_restore"])
    for (const [name, access] of destructive) {
      const inside = name === "session_delete" ? { audiences: ["runtime", "user"], ownerDriven: true } : { audiences: ["user"] }
      expect({ name, ...(access as McpToolAccess) }).toEqual({ name, ...inside, write: true, scope: "admin", destructive: true })
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
    const published = claxedoMcpToolGroupInventory(CLAXEDO_MCP_TOOL_GROUPS)

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
    const published = claxedoMcpToolGroupInventory(CLAXEDO_MCP_TOOL_GROUPS)
    // What a project inherits is computed from these, so a group that reaches
    // past the session and says "runtime" is granted to every project that has
    // decided nothing. The list is short on purpose: adding to it is the
    // decision, and this is where it gets read.
    expect(published.filter((group) => group.reach === "account").map((group) => group.id)).toEqual([])
    expect(published.filter((group) => typeof group.reach === "object").map((group) => group.id)).toEqual(["app-plugins"])
    expect(published.filter((group) => group.reach === "runtime").map((group) => group.id)).toEqual([
      "attention",
      "review",
      "sessions",
      "subagents",
      "surfaces",
      "workspaces",
    ])
  })
})

describe("the transcript's first-party roster", () => {
  // Read as text, not imported: the app is a UI package this server package
  // must not resolve.
  test("names every tool the core groups register, so a renamed or added tool cannot render as a generic row", () => {
    const source = readFileSync(new URL("../../../claxedo-app/src/transcript/claxedo-tool-view.ts", import.meta.url), "utf8")
    const block = source.split("export const CLAXEDO_TOOL_TITLE_KEYS: Partial<Record<ClaxedoToolName, TranscriptTextKey>> = {")[1]?.split("\n}")[0] ?? ""
    const roster = [...block.matchAll(/^\s*([a-z_]+):\s*"transcript\.claxedoTool\.[a-z_]+",$/gm)].map((match) => match[1]).sort()
    const registered = claxedoMcpToolGroupInventory(CLAXEDO_MCP_TOOL_GROUPS).flatMap((group) => group.tools).sort()
    expect(roster.length).toBeGreaterThan(0)
    expect(registered.filter((tool) => !roster.includes(tool))).toEqual([])
  })
})
