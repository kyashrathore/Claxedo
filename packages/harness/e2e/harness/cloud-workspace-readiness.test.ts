import { afterAll, expect, mock, spyOn, test } from "bun:test"
import type { SignedStack } from "../../../claxedo-app/e2e/harness/signed-stack"

const original = { ...await import("./hosted-auth") }
afterAll(() => mock.module("./hosted-auth", () => original))
const requests: Array<{ route: string; method?: string; person: unknown }> = []
let starts = 0
mock.module("./hosted-auth", () => ({
  ...original,
  hostedFetch: async (_stack: unknown, route: string, options: RequestInit, person: unknown) => {
    requests.push({ route, method: options.method, person })
    if (options.method === "POST" && ++starts === 1) return Response.json({ error: { code: "cloud_runtime_unavailable" } }, { status: 409 })
    return Response.json(options.method === "POST" ? {} : { runtimeAccessToken: "ready-token" })
  },
}))
const { startCloudWorkspace } = await import("../../../claxedo-app/e2e/harness/cloud")

test("browser cloud start uses hosted provisioning and relay readiness before returning", async () => {
  const hosted = { workerUrl: "https://hosted.invalid", relayUrl: "http://relay.invalid", root: "/tmp/cloud-readiness-test" }
  const person = { id: "owner", cookie: "owner-cookie" }
  const signed = { hosted, owner: { person, transport: async () => ({ status: 409, body: JSON.stringify({ error: { code: "cloud_runtime_unavailable" } }) }) } } as unknown as SignedStack
  let healthRequests = 0
  const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (url: Parameters<typeof globalThis.fetch>[0], options?: RequestInit) => {
    expect(String(url)).toBe(`${hosted.relayUrl}/workspaces/ws_cloud/api/wr/health`)
    expect(new Headers(options?.headers).get("authorization")).toBe("Bearer ready-token")
    return new Response(null, { status: ++healthRequests === 1 ? 503 : 200 })
  }, { preconnect: globalThis.fetch.preconnect }))
  try {
    await startCloudWorkspace(signed, { id: "ws_cloud", projectId: "prj_cloud" })
    expect(requests).toEqual([
      { route: "/api/workspace/ws_cloud/connection", method: "POST", person },
      { route: "/api/workspace/ws_cloud/connection", method: "POST", person },
      { route: "/api/workspace/ws_cloud/connection", method: undefined, person },
    ])
    expect(healthRequests).toBe(2)
  } finally { fetch.mockRestore() }
})
