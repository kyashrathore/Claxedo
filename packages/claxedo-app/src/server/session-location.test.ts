/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import { createRoot } from "solid-js"
import { placementId, projectId, sessionId } from "./ids"
import { localSessionLocationQuery } from "./session-location"
import { createTransport } from "./transport"
import { createWorkspaces } from "./workspaces"

const running: Array<ReturnType<typeof Bun.serve>> = []
afterEach(() => running.splice(0).forEach((server) => server.stop(true)))

const bootstrap = { deployment: { serverKind: "daemon" }, project: [{ id: "project", worktree: "/app", workspaces: { "/app": { id: "workspace", directory: "/app", reachable: true } } }] }

function world(location: unknown, status = 200, catalog: unknown = bootstrap) {
  const requests: string[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => {
    const path = new URL(request.url).pathname
    requests.push(path)
    if (path === "/api/claxedo/bootstrap") return Response.json(catalog)
    return Response.json(location, { status })
  } })
  running.push(server)
  const transport = createTransport({ serverUrl: `http://127.0.0.1:${server.port}` })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const workspaces = createWorkspaces(transport, queryClient)
  return { requests, workspaces, read: () => queryClient.fetchQuery(localSessionLocationQuery(transport, workspaces, sessionId("older"))) }
}

test("cold local route reads only exact identity and validates its canonical placement", async () => {
  await createRoot(async (dispose) => {
    const target = world({ sessionId: "older", workspaceId: "workspace", projectId: "project" })
    expect(await target.read()).toEqual({ sessionId: sessionId("older"), placementId: placementId("workspace"), projectId: projectId("project") })
    expect(target.requests).toEqual(["/api/claxedo/session/older/location", "/api/claxedo/bootstrap"])
    target.workspaces.dispose()
    dispose()
  })
})

test.each([
  [{ sessionId: "wrong", workspaceId: "workspace", projectId: "project" }, "internal"],
  [{ sessionId: "older", workspaceId: "workspace", projectId: "wrong" }, "not_found"],
  [{ sessionId: "older", workspaceId: "missing", projectId: "project" }, "not_found"],
  [{ sessionId: "older" }, "internal"],
] as const)("local route refuses a mismatched canonical identity %j", async (location, errorClass) => {
  await createRoot(async (dispose) => {
    const target = world(location)
    await expect(target.read()).rejects.toMatchObject({ class: errorClass })
    expect(target.requests.some((path) => path.includes("session-list"))).toBe(false)
    target.workspaces.dispose()
    dispose()
  })
})

test("a missing local session remains a typed failure without requesting the catalog", async () => {
  await createRoot(async (dispose) => {
    const target = world({ error: "Missing" }, 404)
    await expect(target.read()).rejects.toMatchObject({ class: "not_found", status: 404 })
    expect(target.requests).toEqual(["/api/claxedo/session/older/location"])
    target.workspaces.dispose()
    dispose()
  })
})
