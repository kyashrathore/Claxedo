import { afterAll, afterEach, expect, spyOn, test } from "bun:test"
import { transitionRuntimeRoute, type RuntimeRouteState } from "./direct-route"
import { createTransport } from "./transport"

const fetcher = spyOn(globalThis, "fetch")
const warnings = spyOn(console, "warn").mockImplementation(() => undefined)
const routes = { port: 44321, addresses: ["192.168.1.20"], spkiSha256: "A".repeat(43) }
const machineLink = { backing: "local-worktree", relayUrl: "https://relay.test", runtimeAccessToken: "owner-rat", tokenExpiresAt: Date.now() + 3_600_000, directRoutes: routes }
const machine = { directory: "workspace:ws_machine", workspaceId: "ws_machine", remote: true }
const DAEMON = "http://127.0.0.1:4444"

afterEach(() => {
  fetcher.mockReset()
  warnings.mockClear()
})
afterAll(() => {
  fetcher.mockRestore()
  warnings.mockRestore()
})

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))
const href = (url: string | URL | Request) => (typeof url === "string" ? url : url instanceof URL ? url.href : url.url)

function daemon(answers: { register: () => Response; direct: () => Response }) {
  fetcher.mockImplementation(Object.assign(async (url: string | URL | Request) => {
    const target = href(url)
    if (target.startsWith(`${DAEMON}/api/claxedo/direct-routes/`)) return answers.register()
    if (target.startsWith(`${DAEMON}/direct/`)) return answers.direct()
    return Response.json({ via: "relay" })
  }, { preconnect: fetch.preconnect }))
  return createTransport({ serverUrl: DAEMON, account: async () => machineLink })
}

test("the route machine moves to direct once the daemon answers, to relay on a refusal, and back on a recheck", () => {
  const steps: Array<[Parameters<typeof transitionRuntimeRoute>[1], RuntimeRouteState["kind"]]> = [
    [{ type: "routesNamed", routes }, "probing"],
    [{ type: "answered" }, "direct"],
    [{ type: "routesNamed", routes }, "direct"],
    [{ type: "refused" }, "refused"],
    [{ type: "answered" }, "refused"],
    [{ type: "recheck" }, "probing"],
    [{ type: "answered" }, "direct"],
    [{ type: "routesNamed", routes: { ...routes, addresses: ["100.64.0.7"] } }, "probing"],
    [{ type: "routesNamed", routes: undefined }, "relay"],
    [{ type: "refused" }, "relay"],
    [{ type: "recheck" }, "relay"],
  ]
  let state: RuntimeRouteState = { kind: "relay" }
  for (const [event, kind] of steps) {
    state = transitionRuntimeRoute(state, event)
    expect(state.kind, JSON.stringify(event)).toBe(kind)
  }
})

test("a signed desktop sends a machine's runtime traffic through the daemon's direct route once it answers, with the workspace's own token", async () => {
  const transport = daemon({ register: () => Response.json({ address: "192.168.1.20" }), direct: () => Response.json({ via: "direct" }) })

  expect(await (await transport.runtime(machine, "/session")).json()).toEqual({ via: "relay" })
  await settled()
  expect(transport.runtimeRoute("ws_machine")).toBe("direct")
  const registration = fetcher.mock.calls.find(([url]) => href(url).includes("/api/claxedo/direct-routes/"))
  expect(JSON.parse(String(registration?.[1]?.body))).toEqual(routes)

  expect(await (await transport.runtime(machine, "/session?directory=workspace%3Aws_machine")).json()).toEqual({ via: "direct" })
  const [url, init] = fetcher.mock.calls.at(-1) ?? []
  expect(href(url!)).toBe(`${DAEMON}/direct/workspaces/ws_machine/session`)
  expect(new Headers(init?.headers).get("authorization")).toBe("Bearer owner-rat")
})

test("a refused direct route sends that request through the relay, says so, and is asked again only on a recheck", async () => {
  let direct = () => Response.json({ error: { code: "direct_route_unavailable", message: "No address answered" } }, { status: 503 })
  let register = () => Response.json({ address: "192.168.1.20" })
  const transport = daemon({ register: () => register(), direct: () => direct() })
  await transport.runtime(machine, "/session")
  await settled()

  expect(await (await transport.runtime(machine, "/session")).json()).toEqual({ via: "relay" })
  expect(transport.runtimeRoute("ws_machine")).toBe("relay")
  expect(warnings).toHaveBeenCalledTimes(1)
  const sent = fetcher.mock.calls.length
  await transport.runtime(machine, "/session")
  expect(fetcher.mock.calls.slice(sent).map(([url]) => href(url))).toEqual(["https://relay.test/workspaces/ws_machine/session"])

  direct = () => Response.json({ via: "direct" })
  register = () => Response.json({ address: "192.168.1.20" })
  transport.recheckRoutes()
  await settled()
  expect(transport.runtimeRoute("ws_machine")).toBe("direct")
  expect(await (await transport.runtime(machine, "/session")).json()).toEqual({ via: "direct" })
})

test("a machine whose routes no address answers stays on the relay, and a browser never asks a daemon", async () => {
  const transport = daemon({ register: () => Response.json({ error: { code: "direct_route_unavailable", message: "none" } }, { status: 503 }), direct: () => Response.json({ via: "direct" }) })
  await transport.runtime(machine, "/session")
  await settled()
  expect(transport.runtimeRoute("ws_machine")).toBe("relay")
  expect(await (await transport.runtime(machine, "/session")).json()).toEqual({ via: "relay" })

  fetcher.mockReset().mockResolvedValue(Response.json({ via: "relay" }))
  const browser = createTransport({ serverUrl: "https://app.test", cookies: true, relayUrl: "https://app.test/relay" })
  expect(browser.runtimeRoute("ws_machine")).toBe("relay")
  expect(fetcher.mock.calls.some(([url]) => href(url).includes("/direct"))).toBe(false)
})
