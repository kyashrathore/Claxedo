import { describe, expect, test } from "bun:test"
import { CLAXEDO_DAEMON_CAPABILITY_HEADER, createDaemonFetch } from "./daemon-request"

const DAEMON = "http://127.0.0.1:2593"

function harness(options: { capability?: string; respond?: () => Response } = {}) {
  const sent: Array<{ url: string; headers: Headers; redirect: RequestRedirect | undefined }> = []
  const daemon = createDaemonFetch({
    endpoint: () => ({ origin: DAEMON, capability: options.capability ?? "installation-secret" }),
    fetch: async (url, init) => {
      sent.push({ url: url.href, headers: new Headers(init.headers), redirect: init.redirect })
      return options.respond?.() ?? new Response("{}", { status: 200 })
    },
  })
  return { daemon, sent }
}

describe("main's daemon fetch", () => {
  test("resolves a path against the daemon and presents the capability", async () => {
    const { daemon, sent } = harness()

    await daemon("/api/claxedo/host-serving", { method: "PUT" })

    expect(sent[0]?.url).toBe(`${DAEMON}/api/claxedo/host-serving`)
    expect(sent[0]?.headers.get(CLAXEDO_DAEMON_CAPABILITY_HEADER)).toBe("installation-secret")
  })

  // A redirect would replay these headers at whatever `Location` named, which is
  // how a loopback credential leaves the machine. The daemon issues none.
  test("never follows a redirect", async () => {
    const { daemon, sent } = harness()

    await daemon("/api/claxedo/daemon")

    expect(sent[0]?.redirect).toBe("error")
  })

  test("refuses to send the capability anywhere but the daemon", async () => {
    const { daemon, sent } = harness()

    await expect(daemon("https://attacker.example/steal")).rejects.toThrow(/refusing to present the daemon capability/)
    expect(sent).toEqual([])
  })

  test("drops a capability header the caller supplied, and keeps the bearer beside it", async () => {
    const { daemon, sent } = harness()

    await daemon("/api/claxedo/daemon", {
      headers: { [CLAXEDO_DAEMON_CAPABILITY_HEADER]: "a-caller's-idea", authorization: "Bearer installation-secret" },
    })

    expect(sent[0]?.headers.get(CLAXEDO_DAEMON_CAPABILITY_HEADER)).toBe("installation-secret")
    // The lifecycle routes authenticate the bearer; the gate ahead of them reads
    // the capability. Neither presentation may consume the other's header.
    expect(sent[0]?.headers.get("authorization")).toBe("Bearer installation-secret")
  })

  // A server main was pointed at but never given an identity for. Sending
  // nothing is the honest state: the daemon refuses, visibly.
  test("sends no capability when this process holds none", async () => {
    const daemon = createDaemonFetch({
      endpoint: () => ({ origin: DAEMON, capability: undefined }),
      fetch: async (_url, init) =>
        Response.json({ capability: new Headers(init.headers).get(CLAXEDO_DAEMON_CAPABILITY_HEADER) }),
    })

    const answer = await daemon("/api/claxedo/host-serving")

    expect(await answer.json()).toEqual({ capability: null })
  })
})
