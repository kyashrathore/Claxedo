import { expect, test, spyOn } from "bun:test"
import { AgentHookRoutes } from "../routes/agent-hook"
import { Pty } from "../pty/index"
import { defaultStatusHooks } from "../status-hooks"
import type { StatusHookTemplate } from "@claxedo/plugin-api"

test("the lifecycle route selects the envelope provider's active template when event names overlap", async () => {
  const terminalId = "plugin-hook-route"
  const terminal = spyOn(Pty, "get").mockImplementation((id) =>
    id === terminalId
      ? { id, title: id, command: "/bin/sh", args: [], cwd: "/tmp", status: "running", pid: 1 }
      : undefined,
  )
  const template: StatusHookTemplate = {
    command: "route-agent",
    provider: "route-agent",
    install: { type: "wrapper-flags", args: [] },
    events: { Stop: "waiting" },
    subagent: ["worker_id"],
  }
  try {
    const app = AgentHookRoutes({ statusHooks: [...defaultStatusHooks, template] })
    const response = await app.request("http://localhost/agent-lifecycle", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        tabId: terminalId,
        terminalId,
        provider: "route-agent",
        providerEvent: JSON.stringify({ hook_event_name: "Stop", worker_id: "child" }),
      }),
    })
    expect(response.status).toBe(200)
    const state = await (await app.request(`http://localhost/terminal-session?terminalId=${terminalId}`)).json()
    expect(state.session.eventType).toBe("UserActionRequired")
    expect(state.session.provider).toBe("route-agent")
  } finally {
    terminal.mockRestore()
  }
})

test("a template's command can carry its provider identity at the lifecycle route", async () => {
  const terminalId = "plugin-command-route"
  const terminal = spyOn(Pty, "get").mockImplementation((id) =>
    id === terminalId
      ? { id, title: id, command: "/bin/sh", args: [], cwd: "/tmp", status: "running", pid: 1 }
      : undefined,
  )
  const template: StatusHookTemplate = {
    command: "plugin-cli",
    provider: "plugin-provider",
    install: { type: "wrapper-flags", args: [] },
    events: { Stop: "waiting" },
    subagent: [],
  }
  try {
    const app = AgentHookRoutes({ statusHooks: [template] })
    await app.request("http://localhost/agent-lifecycle", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        tabId: terminalId,
        terminalId,
        provider: template.command,
        providerEvent: JSON.stringify({ hook_event_name: "Stop" }),
      }),
    })
    const state = await (await app.request(`http://localhost/terminal-session?terminalId=${terminalId}`)).json()
    expect(state.session?.eventType).toBe("UserActionRequired")
  } finally {
    terminal.mockRestore()
  }
})

test("core wrappers send canonical lifecycle values without requiring a CLI template", async () => {
  const terminalId = "generic-wrapper-route"
  const terminal = spyOn(Pty, "get").mockImplementation((id) =>
    id === terminalId
      ? { id, title: id, command: "/bin/sh", args: [], cwd: "/tmp", status: "running", pid: 1 }
      : undefined,
  )
  try {
    const app = AgentHookRoutes({ statusHooks: [] })
    for (const eventType of ["Busy", "Idle", "Error"]) {
      await app.request("http://localhost/agent-lifecycle", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          tabId: terminalId,
          terminalId,
          provider: "custom-tool",
          providerEvent: JSON.stringify({ eventType }),
        }),
      })
      const state = await (await app.request(`http://localhost/terminal-session?terminalId=${terminalId}`)).json()
      expect(state.session?.eventType).toBe(eventType)
    }
  } finally {
    terminal.mockRestore()
  }
})
