import { afterEach, describe, expect, test } from "bun:test"
import { resolveDeploymentPosture } from "./deployment-posture"
import { queryKeys } from "@/platform/query/keys"
import { queryClient } from "@/platform/query/query-client"

const BASE = "http://127.0.0.1:2593"

type Call = { url: string; credentials?: RequestCredentials }

function server(respond: (url: string) => Response) {
  const calls: Call[] = []
  const request = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = input instanceof URL ? input.href : input instanceof Request ? input.url : input
    calls.push({ url, ...(init?.credentials ? { credentials: init.credentials } : {}) })
    return respond(url)
  }) as typeof globalThis.fetch
  return { calls, request }
}

function declaring(issuesSessions: boolean) {
  return server(() => Response.json({ healthy: true, deployment: { issuesSessions } }))
}

/** What every in-tree reader sees: the cache the pre-render read writes into. */
function cached(baseUrl: string) {
  return queryClient.getQueryData<boolean>(queryKeys.deployment.issuesSessions(baseUrl))
}

afterEach(() => {
  queryClient.clear()
})

describe("resolveDeploymentPosture", () => {
  test("reads the server's declaration from its bootstrap body", async () => {
    const { calls, request } = declaring(true)

    await expect(resolveDeploymentPosture({ baseUrl: BASE, request })).resolves.toBe(true)
    expect(calls.map((call) => call.url)).toEqual([`${BASE}/api/claxedo/bootstrap`])
  })

  test("a daemon that issues no sessions is a declaration, not a missing one", async () => {
    const { request } = declaring(false)

    await expect(resolveDeploymentPosture({ baseUrl: BASE, request })).resolves.toBe(false)
  })

  // Every surface that reads the posture reads the cache, not this promise: the
  // gate and the identity provider mount long after the entry resolved it.
  test("the answer is cached under the server it came from", async () => {
    const { request } = declaring(true)

    expect(cached(BASE)).toBeUndefined()
    await resolveDeploymentPosture({ baseUrl: BASE, request })

    expect(cached(BASE)).toBe(true)
    expect(cached("https://cloud.example.test")).toBeUndefined()
  })

  // It carries no credential deliberately: the caller that most needs the
  // answer is the one that has not signed in, and the loopback daemon's CORS
  // refuses a credentialed cross-origin read outright.
  test("asks for the declaration without credentials", async () => {
    const { calls, request } = declaring(true)

    await resolveDeploymentPosture({ baseUrl: BASE, request })

    expect(calls[0]?.credentials).toBe("omit")
  })

  // The sign-in gate holds until this settles, so asking twice for an answer
  // that cannot change is a delay in front of the shell and nothing else.
  test("a server that declares no posture is asked once, and leaves it unresolved", async () => {
    const { calls, request } = server(() => Response.json({ healthy: true }))

    await expect(resolveDeploymentPosture({ baseUrl: BASE, request })).resolves.toBeUndefined()
    expect(cached(BASE)).toBeUndefined()
    expect(calls).toHaveLength(1)
  })

  test("a server that could not be reached is worth asking again", async () => {
    const { calls, request } = server(() => {
      throw new Error("connection refused")
    })

    await resolveDeploymentPosture({ baseUrl: BASE, request })

    expect(calls).toHaveLength(3)
  })

  test("an unreachable server leaves it unresolved and never rejects into the entry", async () => {
    const { request } = server(() => {
      throw new Error("connection refused")
    })

    await expect(resolveDeploymentPosture({ baseUrl: BASE, request })).resolves.toBeUndefined()
  })

  test("a refused bootstrap is not read as a posture", async () => {
    const { request } = server(() => new Response("nope", { status: 503 }))

    await expect(resolveDeploymentPosture({ baseUrl: BASE, request })).resolves.toBeUndefined()
  })

  // A host that accepts the connection and never answers is the case an
  // unbounded await turns into a blank page: `render()` has not run, so the
  // only thing on screen is index.html's static spinner, which says nothing and
  // offers no retry. Whatever the browser's own connect timeout is, the entry
  // stops waiting first and lets the tree below hold instead.
  test("a server that never answers does not hold the first render", async () => {
    const request = (() => new Promise<Response>(() => {})) as typeof globalThis.fetch
    const started = Date.now()

    await expect(resolveDeploymentPosture({ baseUrl: BASE, request })).resolves.toBeUndefined()

    expect(Date.now() - started).toBeLessThan(4_000)
  })
})
