/**
 * SPEC: Server-mediated slices promoted from Tier M
 *
 * PURPOSE — Preserve the fast UI and fault-injection cases in their original
 * core specs while proving the server-owned half of six named journeys through
 * a production self-host process. Together with `real-harness-local` (first
 * prompt, reload recovery, harness ownership), this remeasures all nine
 * promotion candidates against their actual owner rather than their filenames.
 *
 * STATE MODEL — A scratch git worktree is registered through workspace resolve.
 * The real server owns workspace records, embedded runtimes, session rows,
 * SQLite session projections, process config, and PTY lifecycle.
 *
 * ANATOMY — `startRealLocalServer` spawns `packages/claxedo-server` through its
 * package start script. Requests below use the same public `/session`,
 * `/api/workspace`, `/api/control/sessions`, and `/api/wr/*` routes as the app.
 *
 * BEHAVIORS — Session mutation persists to the inventory; workspace deletion
 * and recreation change the canonical registry; process CRUD persists in the
 * workspace contract; PTY create/list/delete reaches a real child; permission
 * rules land on the session route; projected sessions remain readable after
 * their workspace/runtime is removed.
 *
 * INVARIANTS — No Playwright interception. No in-process route construction.
 * The scripted model endpoint is the only fake, and no case here needs it.
 * Every negative assertion follows a positive mutation through the same server.
 *
 * HARNESS NOTES — The server is configured with the scripted OpenCode model so
 * session creation never inherits a developer credential. These cases do not
 * prompt; first/multi-turn proof remains in `real-harness-local`.
 *
 * OUT OF SCOPE — Inline editors, dialogs, overlays, race injection, and visual
 * geometry remain Tier M because a real server adds no evidence to those claims.
 */
import { expect, test } from "@playwright/test"
import { startRealLocalServer, type RealLocalServer } from "../helpers/real-local-server"

const TIER_REAL = process.env.CLAXEDO_TIER_REAL_E2E === "1"
let real: RealLocalServer

function query(workspace: { id: string; directory: string }) {
  return `workspaceId=${encodeURIComponent(workspace.id)}&directory=${encodeURIComponent(workspace.directory)}`
}

async function body(response: Response) {
  const value = await response.json().catch(() => undefined)
  expect(response.status, JSON.stringify(value)).toBeGreaterThanOrEqual(200)
  expect(response.status, JSON.stringify(value)).toBeLessThan(300)
  return value
}

async function createSession(workspace: { id: string; directory: string }, title: string) {
  return await body(await fetch(`${real.url}/session?${query(workspace)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  })) as { id: string; title: string; directory: string; time?: { archived?: number } }
}

function inventoryId(item: { id?: string; sessionID?: string; session_id?: string }) {
  return item.id ?? item.sessionID ?? item.session_id
}

test.describe.configure({ mode: "serial" })
test.describe("server-mediated core promotions @core @tier-real @surface-web", () => {
  test.skip(!TIER_REAL, "Tier R requires CLAXEDO_TIER_REAL_E2E=1")
  test.setTimeout(180_000)

  test.beforeAll(async () => {
    real = await startRealLocalServer("promotions")
  })

  test.afterAll(async () => {
    await real?.close()
  })

  test("core-session-actions: rename, archive, inventory projection, and delete use the real session owner", async () => {
    const workspace = await real.makeWorkspace("session-actions")
    const session = await createSession(workspace, "Original title")
    const archivedAt = Date.now()
    const renamed = await body(await fetch(`${real.url}/session/${session.id}?${query(workspace)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed by real server", time: { archived: archivedAt } }),
    })) as { title: string; time?: { archived?: number } }
    expect(renamed).toMatchObject({ title: "Renamed by real server", time: { archived: archivedAt } })

    await expect.poll(async () => {
      const inventory = await body(await fetch(
        `${real.url}/api/control/session-list?scope=workspace&archived=all&directory=${encodeURIComponent(workspace.directory)}`,
      )) as { items?: Array<{ sessionId: string; title: string }> }
      return inventory.items?.find((item) => item.sessionId === session.id)?.title
    }).toBe("Renamed by real server")

    expect((await fetch(`${real.url}/session/${session.id}?${query(workspace)}`, { method: "DELETE" })).status).toBe(200)
    expect((await fetch(`${real.url}/session/${session.id}?${query(workspace)}`)).status).toBe(404)
  })

  test("core-workspace-lifecycle: delete removes the canonical workspace and resolve recreates it", async () => {
    const workspace = await real.makeWorkspace("workspace-lifecycle")
    const deleted = await fetch(`${real.url}/api/workspace/${workspace.id}`, { method: "DELETE" })
    expect(deleted.status, await deleted.clone().text()).toBe(200)
    expect((await fetch(`${real.url}/api/workspace/resolve?workspaceId=${encodeURIComponent(workspace.id)}`)).status).toBe(404)

    const recreated = await body(await fetch(
      `${real.url}/api/workspace/resolve?directory=${encodeURIComponent(workspace.directory)}&create=true`,
    )) as { workspaceId: string; directory: string }
    expect(recreated.directory).toBe(workspace.directory)
    expect(recreated.workspaceId).not.toBe("")
  })

  test("core-processes: process config CRUD persists through the real workspace process routes", async () => {
    const workspace = await real.makeWorkspace("processes")
    const endpoint = `${real.url}/api/wr/process?${query(workspace)}`
    const created = await body(await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-workspace-id": workspace.id },
      body: JSON.stringify({
        id: "proc_real",
        name: "Real process",
        command: "node",
        args: ["-e", "process.exit(0)"],
        autoStart: false,
        restartPolicy: "never",
        maxRestarts: 0,
      }),
    })) as { id: string }
    expect(created.id).toBe("proc_real")
    const listed = await body(await fetch(endpoint, { headers: { "x-workspace-id": workspace.id } })) as {
      configs: Array<{ id: string; name: string }>
      processes: Array<{ configId: string; status: string }>
    }
    expect(listed.configs).toContainEqual(expect.objectContaining({ id: "proc_real", name: "Real process" }))
    expect(listed.processes).toContainEqual(expect.objectContaining({ configId: "proc_real", status: "idle" }))
    expect((await fetch(`${real.url}/api/wr/process/proc_real?${query(workspace)}`, {
      method: "DELETE",
      headers: { "x-workspace-id": workspace.id },
    })).status).toBe(200)
    expect((await body(await fetch(endpoint, { headers: { "x-workspace-id": workspace.id } })) as {
      configs: Array<{ id: string }>
    }).configs.some((item) => item.id === "proc_real")).toBe(false)
  })

  test("core-terminal: PTY create, list, and delete reach a real child process", async () => {
    const workspace = await real.makeWorkspace("terminal")
    const created = await body(await fetch(`${real.url}/api/wr/pty`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-workspace-id": workspace.id,
        "x-opencode-directory": workspace.directory,
      },
      body: JSON.stringify({ title: "Tier R terminal", initialCommand: "printf tier-r-terminal" }),
    })) as { id: string; title?: string }
    expect(created).toMatchObject({ id: expect.any(String), title: "Tier R terminal" })
    const listed = await body(await fetch(`${real.url}/api/wr/pty`, {
      headers: { "x-workspace-id": workspace.id, "x-opencode-directory": workspace.directory },
    })) as Array<{ id: string }>
    expect(listed.some((item) => item.id === created.id)).toBe(true)
    expect((await fetch(`${real.url}/api/wr/pty/${encodeURIComponent(created.id)}`, {
      method: "DELETE",
      headers: { "x-workspace-id": workspace.id, "x-opencode-directory": workspace.directory },
    })).status).toBe(200)
    const after = await body(await fetch(`${real.url}/api/wr/pty`, {
      headers: { "x-workspace-id": workspace.id, "x-opencode-directory": workspace.directory },
    })) as Array<{ id: string }>
    expect(after.some((item) => item.id === created.id)).toBe(false)
  })

  test("core-permission-ruleset-delivery: the complete ruleset is stored on the session route", async () => {
    const workspace = await real.makeWorkspace("permission-ruleset")
    const session = await createSession(workspace, "Permission session")
    const permission = [
      { permission: "*", pattern: "*", action: "ask" },
      { permission: "read", pattern: "*", action: "allow" },
    ]
    const updated = await body(await fetch(`${real.url}/session/${session.id}?${query(workspace)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ permission }),
    })) as { permission?: unknown }
    expect(updated.permission).toEqual(permission)
  })

  test("core-dead-workspace-sessions: control-plane inventory survives workspace runtime removal", async () => {
    const workspace = await real.makeWorkspace("dead-workspace")
    const session = await createSession(workspace, "Persisted after runtime")
    await expect.poll(async () => {
      const inventory = await body(await fetch(
        `${real.url}/api/control/sessions?directory=${encodeURIComponent(workspace.directory)}`,
      )) as { sessions: Array<{ id?: string; sessionID?: string; session_id?: string }> }
      return inventory.sessions.some((item) => inventoryId(item) === session.id)
    }).toBe(true)

    expect((await fetch(`${real.url}/api/workspace/${workspace.id}`, { method: "DELETE" })).status).toBe(200)
    const inventory = await body(await fetch(
      `${real.url}/api/control/sessions?directory=${encodeURIComponent(workspace.directory)}`,
    )) as { sessions: Array<{ id?: string; sessionID?: string; session_id?: string; title?: string }> }
    expect(inventory.sessions.find((item) => inventoryId(item) === session.id)).toMatchObject({
      title: "Persisted after runtime",
    })
  })
})
