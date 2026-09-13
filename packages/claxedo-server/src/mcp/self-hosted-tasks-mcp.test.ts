/**
 * A session's Tasks tools on the self-hosted node, over the real thing in both
 * postures: the real Tasks routes on the real SQLite store, the real first-party
 * MCP mount, the real tool registry, and the same `selfHostedTasksClientInput`
 * the node composes — so a mount that stopped supplying the grant fails here
 * rather than at a live session.
 *
 * `first-party-mcp.test.ts` reaches the same contribution with a stub client
 * and a fixture tool, which can say the mount was built but not whether the
 * routes admit what it presents.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { CLAXEDO_MCP_TOOL_GROUPS, CLAXEDO_MCP_TOOL_GROUP_IDS } from "@claxedo/mcp"
import { createClaxedoMcpClient } from "@claxedo/mcp/client"
import { betterAuthAdapter } from "@claxedo/server-core/platform/auth/auth"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { mountControlPlaneRouteContributions } from "@claxedo/server-core/platform/http/route-contribution"
import { createLocalTasksComposition } from "@claxedo/local-server/tasks/local-composition"
import type { ControlPlaneServices } from "../authority/services"
import { createSelfHostedTasksComposition } from "../tasks/self-hosted-composition"
import { createTasksSessionGrants, selfHostedTasksClientInput } from "../tasks/session-grants"
import { firstPartyMcpContribution } from "./first-party-mcp"

const CLAIMS = { runtimeId: "rt_1", workspaceId: "ws_1", sessionId: "ses_1", expiresAt: Number.MAX_SAFE_INTEGER }
const OWNER = { userId: "alice", actorId: "act_alice", orgId: "org-1", projectId: "project-a" }

let dataDir: string
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "claxedo-self-hosted-tasks-mcp-"))
  for (const key of ["CLAXEDO_DATA_DIR", "CLAXEDO_DEPLOYMENT_MODE"]) saved[key] = process.env[key]
  process.env.CLAXEDO_DATA_DIR = dataDir
  process.env.CLAXEDO_DEPLOYMENT_MODE = "local"
})

afterEach(() => {
  ClaxedoDB.close()
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(dataDir, { recursive: true, force: true })
})

function signedServices(): ControlPlaneServices {
  return {
    auth: betterAuthAdapter({
      issuer: "claxedo-embedded",
      verifier: async (token) =>
        token === "alice" ? { subject: "alice", tokenIdentifier: "session:alice", issuer: "claxedo-embedded" } : null,
    }),
    authority: {
      resolveOrgId: vi.fn(async () => OWNER.orgId),
      authorizeProject: vi.fn(async (_auth: unknown, args: { projectId: string }) =>
        args.projectId === OWNER.projectId ? { ok: true, role: "admin", orgId: OWNER.orgId } : { ok: false },
      ),
      authorizeSessionRead: vi.fn(async () => undefined),
      resolveWorkspaceOwner: vi.fn(async (workspaceId: string) => (workspaceId === CLAIMS.workspaceId ? OWNER : undefined)),
    },
    telemetry: { capture: vi.fn() },
    relay: {},
    sandbox: {},
    localExecution: { enabled: true },
  } as unknown as ControlPlaneServices
}

function unsignedServices(): ControlPlaneServices {
  return {
    ...signedServices(),
    auth: { config: { enabled: false, mode: "unsigned-local", reason: "fixture" } },
  } as unknown as ControlPlaneServices
}

/**
 * The node's own composition, minus the parts a Tasks call never reaches: the
 * Tasks routes this posture mounts, the MCP endpoint, and the supplier that
 * joins them.
 */
function node(posture: "signed" | "unsigned", options: { supplyTasks?: boolean } = {}) {
  const app = new Hono()
  const services = posture === "signed" ? signedServices() : unsignedServices()
  const owner = services.authority?.resolveWorkspaceOwner?.bind(services.authority)
  const grants = posture === "signed" && owner ? createTasksSessionGrants({ workspaceOwner: owner }) : undefined
  const tasks = posture === "signed"
    ? createSelfHostedTasksComposition({ services, ...(grants ? { grants } : {}) }).routeContributions
    : createLocalTasksComposition().routeContributions
  const contribution = firstPartyMcpContribution({
    mount: "node",
    app,
    authority: undefined,
    options: {
      verifyRuntimeCredential: (token) => (token === "rt-token" ? CLAIMS : undefined),
      createClient: (input) => createClaxedoMcpClient(input),
      registerTools: CLAXEDO_MCP_TOOL_GROUPS,
    },
    signedAuth: async () => undefined,
    ...(options.supplyTasks === false
      ? {}
      : {
          tasks: selfHostedTasksClientInput({
            enabledToolGroups: () => CLAXEDO_MCP_TOOL_GROUP_IDS,
            app,
            signed: posture === "signed",
            ...(grants ? { grants } : {}),
          }),
        }),
    // This mount serves no workspace runtime in the fixture; the Tasks tools
    // never reach one, and a tool that did would fail loudly rather than read
    // a fixture's idea of a runtime.
    local: (credential) =>
      credential.kind === "runtime" ? { fetch: async () => new Response(null, { status: 404 }), workspace: {} } : undefined,
    auditFallback: () => undefined,
  })
  mountControlPlaneRouteContributions({
    contributions: [...tasks, contribution],
    mount: (mounted) => app.route(mounted.path, mounted.routes),
  })
  return app
}

async function session(app: Hono) {
  const client = new Client({ name: "fixture", version: "0" })
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://127.0.0.1/api/claxedo/mcp"), {
      fetch: (url, init) => Promise.resolve(app.request(url.toString(), init)),
      requestInit: { headers: { authorization: "Bearer rt-token" } },
    }),
  )
  return client
}

function created(result: unknown) {
  const content = (result as { content?: [{ text?: string }]; isError?: boolean }).content
  return { isError: (result as { isError?: boolean }).isError === true, text: content?.[0]?.text ?? "" }
}

describe.each(["unsigned", "signed"] as const)("the self-hosted node's Tasks tools (%s posture)", (posture) => {
  test("are listed for a session", async () => {
    const client = await session(node(posture))
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    expect(names).toContain("task_create")
    expect(names).toContain("task_list")
  })

  test("are hidden from a session the mount hands no grant", async () => {
    const client = await session(node(posture, { supplyTasks: false }))
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    expect(names).not.toContain("task_create")
    expect(names).not.toContain("task_list")
  })

  test("write a task the routes admit, and read it back", async () => {
    const client = await session(node(posture))
    const write = created(await client.callTool({
      name: "task_create",
      arguments: { title: "Ship the node wiring", project: OWNER.projectId },
    }))
    expect(write.isError, write.text).toBe(false)

    const read = created(await client.callTool({ name: "task_list", arguments: { project: OWNER.projectId } }))
    expect(read.isError, read.text).toBe(false)
    expect(read.text).toContain("Ship the node wiring")
  })
})

describe("the self-hosted node's Tasks grant", () => {
  test("is not issued for a workspace the authority cannot name an owner for", async () => {
    const services = signedServices()
    const owner = services.authority?.resolveWorkspaceOwner?.bind(services.authority)
    if (!owner) throw new Error("the fixture authority resolves no workspace owner")
    const grants = createTasksSessionGrants({ workspaceOwner: owner })
    await expect(grants.issue({ workspaceId: "ws_unknown" })).resolves.toBeUndefined()
  })

  test("stops answering once it is revoked", async () => {
    const services = signedServices()
    const owner = services.authority?.resolveWorkspaceOwner?.bind(services.authority)
    if (!owner) throw new Error("the fixture authority resolves no workspace owner")
    const grants = createTasksSessionGrants({ workspaceOwner: owner })
    const token = await grants.issue({ workspaceId: CLAIMS.workspaceId, sessionId: CLAIMS.sessionId })
    if (!token) throw new Error("the fixture issued no grant")
    // The scope names the workspace; who owns it is resolved again at request
    // time, so the actor is not frozen into the handle.
    await expect(grants.capability.verify(token)).resolves.toEqual({
      userId: OWNER.userId,
      orgId: OWNER.orgId,
      projectId: OWNER.projectId,
      workspaceId: CLAIMS.workspaceId,
      sessionId: CLAIMS.sessionId,
      operations: ["read", "create", "start"],
    })
    grants.revoke(token)
    await expect(grants.capability.verify(token)).resolves.toBeUndefined()
  })
})
