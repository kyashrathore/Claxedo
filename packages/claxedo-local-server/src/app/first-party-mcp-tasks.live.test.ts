import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { sqliteTasksStore } from "@claxedo/server-core/tasks-host/sqlite-store"
import { ensureWorkspace } from "@claxedo/server-core/workspace/store/index"
import { callTool, startLiveFirstPartyMcp, toolJson, toolText, type LiveMcpFixture } from "./test-support/first-party-mcp-live"

/**
 * The Tasks tools a local session is actually handed, over the composition the
 * desktop ships: the real Marketplace switch, the real Tasks routes on the real
 * SQLite store, the real local bridge, and the grant the MCP mount issues for
 * the calling session.
 *
 * The person at this machine and the model inside a session reach these routes
 * on the same loopback, and the grant is the only thing that tells them apart:
 * what a session may start, which project it may work in, and whose name the
 * link carries all hang off it (security review P105). The second workspace
 * here is what makes the difference observable — it sits in its own project,
 * which this session was never given.
 */

const TASKS = "/api/claxedo/tasks"

type CommandResult = { result: { type: string; task?: { id: string }; preset?: { id: string; name: string } } }

let live: LiveMcpFixture
let elsewhere: { id: string; directory: string; projectId: string }
let ownProject: string
let session: string
let client: Client

const tasksRequest = async (pathAndQuery: string, init?: RequestInit) => {
  const response = await live.call(`http://127.0.0.1:${live.port}${TASKS}${pathAndQuery}`, init)
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

/** A command as the person at this machine, which is the caller these routes were built for. */
const command = async (clientRequestId: string, body: Record<string, unknown>) => {
  const answered = await tasksRequest("/commands", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientRequestId, command: body }),
  })
  if (answered.status !== 200) throw new Error(`the tasks routes refused ${clientRequestId}: ${JSON.stringify(answered.body)}`)
  return answered.body as unknown as CommandResult
}

const preset = async (id: string, name: string, agentStartable: boolean) =>
  (await command(id, {
    type: "preset.create",
    input: {
      name,
      instructions: "Read the change before proposing one.",
      execution: { placement: "local", capabilities: { mode: "inherit-local" } },
      agentStartable,
      configurations: {
        primary: {
          harness: { id: "claude", access: "native" },
          model: { providerID: "anthropic", modelID: "sonnet" },
          effort: null,
        },
      },
    },
  })).result.preset?.name ?? name

const task = async (id: string, title: string, workspaceId: string | null) =>
  (await command(id, {
    type: "task.create",
    input: { projectId: ownProject, title, description: "", workspaceId, parentTaskId: null },
  })).result.task?.id ?? ""

beforeAll(async () => {
  live = await startLiveFirstPartyMcp()
  ownProject = live.workspace.project_id ?? live.workspace.id

  const directory = mkdtempSync(path.join(tmpdir(), "claxedo-first-party-mcp-elsewhere-"))
  const git = (args: readonly string[]) => execFileSync("git", [...args], { cwd: directory, stdio: "pipe" })
  git(["init", "-b", "main"])
  git(["config", "user.email", "fixture@example.com"])
  git(["config", "user.name", "Fixture"])
  const stored = await ensureWorkspace({ directory })
  if (!stored) throw new Error("the workspace store stored no row for the second fixture directory")
  elsewhere = { id: stored.id, directory, projectId: stored.project_id ?? stored.id }

  // The switch the desktop's Marketplace flips; without it this session is
  // served no Tasks tools at all.
  const plugins = `http://127.0.0.1:${live.port}/api/claxedo/plugins`
  const before = await (await live.call(plugins)).json() as { revision: number }
  const written = await live.call(`${plugins}/activation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pluginInstanceId: "claxedo:tasks",
      harnessIds: ["opencode", "claude", "codex", "cursor"],
      choice: true,
      expectedRevision: before.revision,
    }),
  })
  if (written.status !== 200) throw new Error(`the Marketplace refused the Tasks switch: ${written.status}`)

  session = await live.createSession("tasks caller")
  client = await live.connect(session)
}, 60_000)

afterAll(async () => {
  await live?.stop()
  if (elsewhere) rmSync(elsewhere.directory, { recursive: true, force: true })
})

describe("the Tasks tools a local session reaches through its own grant", () => {
  test("writes a task down as itself and reads its own project back", async () => {
    const written = await callTool(client, "task_create", { title: "Written from inside a session" })
    expect(written.isError, toolText(written)).toBeFalsy()
    const created = toolJson(written) as { task: { id: string; project: string; createdFrom?: { sessionId: string; workspaceId: string } } }
    expect(created.task.project).toBe(ownProject)
    expect(created.task.createdFrom).toEqual({ sessionId: session, workspaceId: live.workspace.id })

    const listed = toolJson(await callTool(client, "task_list")) as { project: string; tasks: Array<{ id: string }> }
    expect(listed.project).toBe(ownProject)
    expect(listed.tasks.map((row) => row.id)).toContain(created.task.id)
  })

  test("is refused a project its own workspace does not sit in", async () => {
    const refused = await callTool(client, "task_list", { project: elsewhere.projectId })
    expect(refused.isError).toBe(true)
    expect(toolText(refused)).toBe(`This session may act only in project ${ownProject}`)
  })

  test("cannot start a task the owner pointed at another project's workspace, and starts nothing there", async () => {
    const startable = await preset("preset-agent-startable", "Agents may start this", true)
    const pointedElsewhere = await task("task-elsewhere", "Runs in the other workspace", elsewhere.id)

    const refused = await callTool(client, "task_start", { task: pointedElsewhere, preset: startable })
    expect(refused.isError).toBe(true)
    expect(toolText(refused)).toBe(`This session may act only in project ${ownProject}`)

    // Nothing was reserved, created or linked on the way to the refusal.
    const read = await tasksRequest(`/tasks/${pointedElsewhere}`)
    expect(read.status).toBe(200)
    expect(read.body.links).toEqual([])
  })

  test("cannot start a preset nobody marked for agents, while the person still can", async () => {
    const personOnly = await preset("preset-person-only", "People only", false)
    const own = await task("task-own-preset-gate", "Runs here", live.workspace.id)

    const refused = await callTool(client, "task_start", { task: own, preset: personOnly })
    expect(refused.isError).toBe(true)
    expect(toolText(refused)).toContain("not marked as startable by agents")

    const detail = await tasksRequest(`/tasks/${own}`)
    const revision = (detail.body.task as { revision: number }).revision
    const presets = await tasksRequest("/presets")
    const row = (presets.body.items as Array<{ id: string; name: string; revision: number }>).find((item) => item.name === personOnly)
    if (!row) throw new Error("the fixture preset is not in the person's catalog")
    const preview = await tasksRequest(`/tasks/${own}/start-preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskRevision: revision,
        presetId: row.id,
        presetRevision: row.revision,
        slot: "primary",
        attempt: 1,
        continueFromPrevious: false,
      }),
    })
    // The person's Start is untouched by the agent gates: the same preset and
    // the same task preview as startable for them.
    expect(preview.status).toBe(200)
    expect(preview.body.preview).toMatchObject({ available: true })
  })

  test("starts a task of its own project, and the link records the session that asked", async () => {
    const startable = await preset("preset-agent-startable-2", "Agents may start this one too", true)
    const own = await task("task-own-startable", "Runs in this session's own workspace", live.workspace.id)

    const answered = await callTool(client, "task_start", { task: own, preset: startable })
    expect(answered.isError, toolText(answered)).toBeFalsy()
    const started = toolJson(answered) as { session: { sessionId: string; workspaceId: string }; slot: string; attempt: number }
    expect(started.session.workspaceId).toBe(live.workspace.id)

    // What the routes wrote down about who asked, which is what a per-project
    // cap on agent-started work counts and what an audit reads. The tool's own
    // answer cannot say it: the link is the record, not the response.
    const link = await sqliteTasksStore.links.bySession("local", started.session.sessionId)
    expect(link).toMatchObject({
      taskId: own,
      startedBy: "agent",
      startedFrom: { sessionId: session, workspaceId: live.workspace.id },
    })
  })
})
