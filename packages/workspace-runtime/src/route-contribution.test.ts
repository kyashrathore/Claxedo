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
    directory: "/workspace",
    stateDirectory: "/runtime-state",
    applyHarnessLaunch: async () => {},
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

  // NOT COVERED HERE, deliberately: session-tool group MERGING.
  //
  // A test of it lived here and was worthless — it built its own
  // `registerSessionTools` implementation inline and asserted on that fixture's
  // own bookkeeping, so breaking the real merge in `server.ts` left it green
  // (mutation-proven). `mountRouteContributions` only forwards whatever context
  // it is handed, so there is nothing about merging for a test at THIS layer to
  // check, and it was removed rather than rewritten.
  //
  // Covering it properly needs an observation point that does not exist yet:
  // `createWorkspaceRuntimeApp` returns `host: { ...host, dispose }` — a COPY —
  // so a test cannot intercept what `registerSessionToolGroup` actually calls.
  // The fix is an injectable host on that factory, not another fixture.
})
