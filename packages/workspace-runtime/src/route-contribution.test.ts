import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import {
  mountRouteContributions,
  WorkspaceRuntimeRouteContributionError,
  type WorkspaceRuntimeRouteContext,
  type WorkspaceRuntimeRouteContribution,
} from "./route-contribution"

function context(): WorkspaceRuntimeRouteContext {
  return {
    workspaceId: "ws_1",
    registerSessionTools: () => async () => {},
    unregisterSessionTools: () => async () => {},
  }
}

function contribution(input: {
  id: string
  path?: string
  body?: string
  onDispose?: () => void
}): WorkspaceRuntimeRouteContribution {
  return {
    id: input.id,
    mount() {
      const routes = new Hono()
      routes.get(`/${input.id}`, (c) => c.text(input.body ?? input.id))
      return {
        path: input.path ?? "/",
        routes,
        dispose: input.onDispose ?? (() => {}),
      }
    },
  }
}

describe("workspace runtime route contributions", () => {
  test("mounts nothing when a host contributes nothing", async () => {
    const app = new Hono()
    app.get("/health", (c) => c.text("ok"))

    const mounted = mountRouteContributions({ app, contributions: [], context: context() })

    expect((await app.request("/health")).status).toBe(200)
    expect((await app.request("/anything")).status).toBe(404)
    mounted.dispose()
  })

  test("mounts each contribution's routes at its declared path", async () => {
    const app = new Hono()
    mountRouteContributions({
      app,
      contributions: [contribution({ id: "alpha" }), contribution({ id: "beta", path: "/api" })],
      context: context(),
    })

    expect(await (await app.request("/alpha")).text()).toBe("alpha")
    expect(await (await app.request("/api/beta")).text()).toBe("beta")
  })

  test("passes the runtime context through to the contribution", () => {
    const seen: string[] = []
    const app = new Hono()
    mountRouteContributions({
      app,
      contributions: [
        {
          id: "records-context",
          mount(runtime) {
            seen.push(runtime.workspaceId)
            return { path: "/", routes: new Hono(), dispose: () => {} }
          },
        },
      ],
      context: context(),
    })

    expect(seen).toEqual(["ws_1"])
  })

  test("rejects a duplicate contribution id instead of shadowing one", () => {
    // Two contributions claiming one ID is a composition bug. Keeping the
    // second silently is how it stays invisible until a route goes missing.
    expect(() =>
      mountRouteContributions({
        app: new Hono(),
        contributions: [contribution({ id: "same", body: "first" }), contribution({ id: "same", body: "second" })],
        context: context(),
      }),
    ).toThrow(WorkspaceRuntimeRouteContributionError)
  })

  test("disposes every contribution exactly once", () => {
    const disposals: string[] = []
    const mounted = mountRouteContributions({
      app: new Hono(),
      contributions: [
        contribution({ id: "alpha", onDispose: () => disposals.push("alpha") }),
        contribution({ id: "beta", onDispose: () => disposals.push("beta") }),
      ],
      context: context(),
    })

    mounted.dispose()
    mounted.dispose()

    expect(disposals).toEqual(["alpha", "beta"])
  })

  test("a contribution that throws while disposing does not strand the others", () => {
    // Shutdown path: the alternative to swallowing this is a process that
    // never exits because one callback server refused to close.
    const disposals: string[] = []
    const mounted = mountRouteContributions({
      app: new Hono(),
      contributions: [
        contribution({
          id: "explodes",
          onDispose: () => {
            disposals.push("explodes")
            throw new Error("callback server refused to close")
          },
        }),
        contribution({ id: "clean", onDispose: () => disposals.push("clean") }),
      ],
      context: context(),
    })

    expect(() => mounted.dispose()).not.toThrow()
    expect(disposals).toEqual(["explodes", "clean"])
  })

  test("merges session tool groups so one contribution cannot erase another's tools", async () => {
    // The reason `registerSessionTools` takes a group name at all. Two
    // contributions registering for the same session must both survive.
    const registrations: Array<{ sessionId: string; tools: string[] }> = []
    const groups = new Map<string, Map<string, string[]>>()

    const runtime: WorkspaceRuntimeRouteContext = {
      workspaceId: "ws_1",
      registerSessionTools: (group) => async (registration) => {
        const bySession = groups.get(registration.sessionId) ?? new Map<string, string[]>()
        bySession.set(group, registration.tools.map((tool) => tool.name))
        groups.set(registration.sessionId, bySession)
        registrations.push({
          sessionId: registration.sessionId,
          tools: [...bySession.values()].flat().toSorted(),
        })
      },
      unregisterSessionTools: (group) => async (sessionId) => {
        groups.get(sessionId)?.delete(group)
      },
    }

    await runtime.registerSessionTools("connections")({
      sessionId: "ses_1",
      callbackUrl: "http://127.0.0.1:1/callback",
      tools: [{ name: "connections.list", description: "", inputSchema: {} }],
    })
    await runtime.registerSessionTools("run")({
      sessionId: "ses_1",
      callbackUrl: "http://127.0.0.1:1/callback",
      tools: [{ name: "run.report", description: "", inputSchema: {} }],
    })

    expect(registrations.at(-1)).toEqual({
      sessionId: "ses_1",
      tools: ["connections.list", "run.report"],
    })
  })
})
