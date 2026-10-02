import { expect, spyOn, test } from "bun:test"
import type { StatusHookTemplate } from "@claxedo/plugin-api"
import { AgentHookRoutes } from "../routes/agent-hook"
import { Pty } from "../pty/index"
import { defaultStatusHooks } from "../status-hooks"
import { createBus, type WorkspaceRuntimeEvent } from "@claxedo/session-core"

async function lifecycle(statusHooks: StatusHookTemplate[], provider: string, events: Record<string, unknown>[]) {
  const terminalId = `route-${provider}`
  const terminal = spyOn(Pty, "get").mockImplementation((id) =>
    id === terminalId ? { id, title: id, command: "/bin/sh", args: [], cwd: "/tmp", status: "running", pid: 1 } : undefined,
  )
  try {
    const app = AgentHookRoutes({ bus: createBus<WorkspaceRuntimeEvent>(), statusHooks })
    const sessions = []
    for (const event of events) {
      const posted = await app.request("http://localhost/agent-lifecycle", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ tabId: terminalId, terminalId, provider, providerEvent: JSON.stringify(event) }),
      })
      expect(posted.status).toBe(200)
      sessions.push((await (await app.request(`http://localhost/terminal-session?terminalId=${terminalId}`)).json()).session)
    }
    return sessions
  } finally {
    terminal.mockRestore()
  }
}

test("the lifecycle route maps an event through the envelope provider's template when names overlap", async () => {
  const template: StatusHookTemplate = {
    command: "route-agent",
    provider: "route-agent",
    install: { type: "wrapper-flags", args: [] },
    events: { Stop: "waiting" },
    subagent: [],
  }
  const [session] = await lifecycle([...defaultStatusHooks, template], "route-agent", [{ hook_event_name: "Stop" }])
  expect(session).toMatchObject({ eventType: "UserActionRequired", provider: "route-agent" })
})

test("a wrapper with no template reports the engine's own statuses at the lifecycle route", async () => {
  const statuses = ["Busy", "Idle", "Error"]
  const sessions = await lifecycle([], "custom-tool", statuses.map((status) => ({ hook_event_name: status })))
  expect(sessions.map((session) => session.eventType)).toEqual(statuses)
})
