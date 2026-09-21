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
import { execFileSync } from "node:child_process"
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
import { ensureWorkspace } from "@claxedo/server-core/workspace/store/index"
import { createLocalTasksComposition } from "@claxedo/local-server/tasks/local-composition"
import type { ControlPlaneServices } from "../authority/services"
import { createSelfHostedTasksComposition } from "../tasks/self-hosted-composition"
import { createTasksSessionGrants } from "@claxedo/server-core/tasks-host/session-grants"
import { selfHostedTasksClientInput } from "../tasks/session-grants"
import { firstPartyMcpContribution } from "./first-party-mcp"

const CLAIMS = { runtimeId: "rt_1", workspaceId: "ws_1", sessionId: "ses_1", expiresAt: Number.MAX_SAFE_INTEGER }
const OWNER = { userId: "alice", actorId: "act_alice", orgId: "org-1", projectId: "project-a" }

let dataDir: string
const workspaceDirs: string[] = []
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
  for (const directory of workspaceDirs.splice(0)) rmSync(directory, { recursive: true, force: true })
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
 * A workspace of this box's own, as a row in the local store. The unsigned
 * posture reads its grant's owner and project from that row, so a fixture that
 * named a workspace nobody stored would be handed no grant at all.
 */
async function localWorkspaceRow() {
  const directory = mkdtempSync(path.join(tmpdir(), "claxedo-self-hosted-tasks-ws-"))
  workspaceDirs.push(directory)
  const git = (args: readonly string[]) => execFileSync("git", [...args], { cwd: directory, stdio: "pipe" })
  // The workspace store refuses a local directory that is not a git repository.
  git(["init", "-b", "main"])
  git(["config", "user.email", "fixture@example.com"])
  git(["config", "user.name", "Fixture"])
  const workspace = await ensureWorkspace({ directory })
  if (!workspace) throw new Error("the workspace store stored no row for the fixture directory")
  return workspace
}

/**
 * The node's own composition, minus the parts a Tasks call never reaches: the
 * Tasks routes this posture mounts, the MCP endpoint, and the supplier that
 * joins them. `project` is the one project this posture's session may work in.
 */
async function node(posture: "signed" | "unsigned", options: { supplyTasks?: boolean } = {}) {
  const app = new Hono()
  const services = posture === "signed" ? signedServices() : unsignedServices()
  const owner = services.authority?.resolveWorkspaceOwner?.bind(services.authority)
  // Each posture's own registry, exactly as `selfHostedTasks` composes it: the
  // signed box resolves owners from its authority, the unsigned one from the
  // local composition that also mounts its routes.
  const local = posture === "unsigned" ? createLocalTasksComposition() : undefined
  const workspace = local ? await localWorkspaceRow() : undefined
  const claims = { ...CLAIMS, ...(workspace ? { workspaceId: workspace.id } : {}) }
  const grants = local?.grants ?? (owner ? createTasksSessionGrants({ workspaceOwner: owner }) : undefined)
  const tasks = local?.routeContributions
    ?? createSelfHostedTasksComposition({ services, ...(grants ? { grants } : {}) }).routeContributions
  const contribution = firstPartyMcpContribution({
    mount: "node",
    app,
    authority: undefined,
    options: {
      verifyRuntimeCredential: (token) => (token === "rt-token" ? claims : undefined),
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
  return { app, project: workspace ? workspace.project_id ?? workspace.id : OWNER.projectId }
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
    const client = await session((await node(posture)).app)
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    expect(names).toContain("task_create")
    expect(names).toContain("task_list")
  })

  test("are hidden from a session the mount hands no grant", async () => {
    const client = await session((await node(posture, { supplyTasks: false })).app)
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    expect(names).not.toContain("task_create")
    expect(names).not.toContain("task_list")
  })

  test("write a task the routes admit, and read it back", async () => {
    const box = await node(posture)
    const client = await session(box.app)
    const write = created(await client.callTool({
      name: "task_create",
      arguments: { title: "Ship the node wiring", project: box.project },
    }))
    expect(write.isError, write.text).toBe(false)

    const read = created(await client.callTool({ name: "task_list", arguments: { project: box.project } }))
    expect(read.isError, read.text).toBe(false)
    expect(read.text).toContain("Ship the node wiring")
  })

  test("refuse a project the session's own workspace does not sit in", async () => {
    const box = await node(posture)
    const client = await session(box.app)
    const refused = created(await client.callTool({
      name: "task_create",
      arguments: { title: "Someone else's project", project: "project-elsewhere" },
    }))
    expect(refused.isError).toBe(true)
    expect(refused.text).toBe(`This session may act only in project ${box.project}`)

    const read = created(await client.callTool({ name: "task_list", arguments: { project: "project-elsewhere" } }))
    expect(read.isError).toBe(true)
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

  test("names the workspace and session it was issued for, and answers nothing it did not issue", async () => {
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
    await expect(grants.capability.verify(`${token}x`)).resolves.toBeUndefined()
  })
})
