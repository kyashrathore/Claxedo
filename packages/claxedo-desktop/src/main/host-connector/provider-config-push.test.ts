import { describe, expect, test } from "bun:test"

import { setupHostProviderConfigPush } from "./provider-config-push"
import { recordingDaemon } from "../test-support/daemon-fetch"

const PLAINTEXT = JSON.stringify({
  version: 1,
  providers: {
    "claude-sdk": { baseUrl: "https://broker.test/bindings/b1", placeholder: "sk-placeholder-SECRET", authMode: "api-key" },
  },
})

function harness(
  options: {
    respond?: (init?: RequestInit) => Response
    daemonReady?: () => Promise<unknown>
  } = {},
) {
  const logged: string[] = []
  const { daemon, requests } = recordingDaemon({
    respond: (init) =>
      options.respond?.(init) ?? new Response(JSON.stringify({ revision: 3, providerCount: 1 }), { status: 200 }),
  })
  const pusher = setupHostProviderConfigPush({
    daemon,
    daemonReady: options.daemonReady ?? (async () => undefined),
    log: { info: (message) => logged.push(`info ${message}`), warn: (message) => logged.push(`warn ${message}`) },
  })
  return { push: pusher.push, reconcile: pusher.reconcile, requests, logged }
}

describe("the provider-config push", () => {
  test("PUTs the revision and the opened text to the daemon, unparsed", async () => {
    const host = harness()

    await host.push({ revision: 3, providers: PLAINTEXT })

    expect(host.requests).toHaveLength(1)
    expect(host.requests[0]?.url).toBe("http://127.0.0.1:4000/api/claxedo/host-provider-config")
    expect(host.requests[0]?.method).toBe("PUT")
    expect(host.requests[0]?.capability).toBe("daemon-capability")
    expect(host.requests[0]?.body).toEqual({ revision: 3, providers: PLAINTEXT })
  })

  test("a push before the daemon listens is delivered once it does", async () => {
    let ready!: () => void
    const listening = new Promise<void>((resolve) => {
      ready = resolve
    })
    const host = harness({ daemonReady: () => listening })

    const pending = host.push({ revision: 1, providers: PLAINTEXT })
    await Bun.sleep(1)
    expect(host.requests).toEqual([])

    ready()
    await pending
    expect(host.requests).toHaveLength(1)
    expect(host.requests[0]?.body).toEqual({ revision: 1, providers: PLAINTEXT })
  })

  test("only the latest of the revisions that landed while the daemon was starting is delivered", async () => {
    let ready!: () => void
    const listening = new Promise<void>((resolve) => {
      ready = resolve
    })
    const host = harness({ daemonReady: () => listening })

    const first = host.push({ revision: 1, providers: PLAINTEXT })
    const second = host.push({ revision: 2, providers: '{"version":1,"providers":{}}' })
    ready()
    await Promise.all([first, second])

    expect(host.requests.map((request) => (request.body as { revision: number }).revision)).toEqual([2])
  })

  test("logs the revision and the daemon's answer, and nothing from the rows", async () => {
    const host = harness({ respond: () => new Response(JSON.stringify({ revision: 3, providerCount: 1 }), { status: 200 }) })

    await host.push({ revision: 3, providers: PLAINTEXT })

    expect(host.logged).toEqual(['info [host-provider-config] pushed revision=3 -> 200 {"revision":3,"providerCount":1}'])
    expect(host.logged.join("\n")).not.toContain("SECRET")
    expect(host.logged.join("\n")).not.toContain("claude-sdk")
    expect(host.logged.join("\n")).not.toContain("broker.test")
  })

  test("a daemon that refuses a row is reported with its reason", async () => {
    const host = harness({
      respond: () =>
        new Response(JSON.stringify({ error: { code: "invalid_provider_config", message: "row unreadable" } }), { status: 400 }),
    })

    await host.push({ revision: 3, providers: PLAINTEXT })

    expect(host.logged[0]).toContain("revision=3 -> 400")
    expect(host.logged[0]).toContain("invalid_provider_config")
  })

  test("a daemon that restarted and lost the rows is re-pushed the revision main retained", async () => {
    let held: number | null = 4
    const host = harness({
      respond: (init) => {
        if (init?.method !== "PUT") return new Response(JSON.stringify({ revision: held, providerCount: held === null ? 0 : 1 }))
        held = (JSON.parse(typeof init.body === "string" ? init.body : "{}") as { revision: number }).revision
        return new Response(JSON.stringify({ revision: held, providerCount: 1 }))
      },
    })
    await host.push({ revision: 4, providers: PLAINTEXT })
    expect(host.requests).toHaveLength(1)

    await host.reconcile()
    expect(host.requests.map((request) => request.method)).toEqual(["PUT", undefined])

    held = null
    await host.reconcile()

    expect(host.requests.map((request) => request.method)).toEqual(["PUT", undefined, undefined, "PUT"])
    expect(host.requests[3]?.body).toEqual({ revision: 4, providers: PLAINTEXT })
    expect(host.logged.join("\n")).toContain("daemon holds null, re-pushing revision=4")
    expect(host.logged.join("\n")).not.toContain("SECRET")
  })

  test("nothing pushed yet, or a daemon that cannot be read, reconciles to nothing", async () => {
    const quiet = harness()
    await quiet.reconcile()
    expect(quiet.requests).toEqual([])

    const refusing = harness({ respond: () => new Response("no", { status: 503 }) })
    await refusing.push({ revision: 2, providers: PLAINTEXT })
    await refusing.reconcile()
    expect(refusing.requests.map((request) => request.method)).toEqual(["PUT", undefined])
    expect(refusing.logged.join("\n")).toContain("state read -> 503")
  })

  test("a daemon that never answers is reported, not thrown at the heartbeat", async () => {
    const host = harness({
      daemonReady: () => Promise.reject(new Error("claxedo-server failed to start")),
    })

    await host.push({ revision: 3, providers: PLAINTEXT })

    expect(host.requests).toEqual([])
    expect(host.logged).toEqual(["warn [host-provider-config] push failed: Error: claxedo-server failed to start"])
  })
})
