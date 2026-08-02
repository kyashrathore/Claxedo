import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { withWorkerd } from "./workerd-fixture/boot"

/**
 * What the Cloudflare runtime does and does NOT tell a Durable Object about its
 * own WebSocket send buffer.
 *
 * This test exists because a plan (`W7.1a`) proposed fixing a measured cloud
 * failure — the DO's outbound buffer growing until workerd destroys the socket
 * beneath the isolate, surfacing as 1006/1011 with zero logs and 13 ms of CPU —
 * by reading `bufferedAmount` before `send()`, mirroring a guard the Bun adapter
 * appears to have. Neither half of that premise survives contact with the
 * runtimes:
 *
 *   - workerd's WebSocket has no `bufferedAmount` and no `getBufferedAmount()`.
 *     A guard reading it would be `undefined > 8388608` — always false — so it
 *     would be a no-op that reads as a fix. Asserted here against real workerd.
 *   - `Bun.ServerWebSocket` exposes `getBufferedAmount()`, a METHOD, not a
 *     `bufferedAmount` property. `src/bun.ts` reads the property behind a
 *     non-null assertion, so its two "backpressure limit exceeded" closes have
 *     never fired either. Asserted below by driving a real Bun socket.
 *
 * Together those kill the "the asymmetry is the proof" argument: Bun does not
 * survive this load shape because it guards. Its guard has never executed.
 *
 * The value of pinning it: if Cloudflare ever ships the getter, the workerd test
 * below FAILS, and whoever sees it learns that the port has become possible.
 * Until then, no pre-send guard can be written in `cloudflare.ts` at all, and
 * bounding this mechanism needs a protocol-level credit/ack window instead.
 *
 * Runtime globals are structurally typed rather than pulled from
 * `@cloudflare/workers-types`, matching the rest of this package.
 */

/** Enough to sit ~4x over the 8 MiB limit the guards would have used. */
const OVERSHOOT_FRAME_BYTES = 64 * 1024
const OVERSHOOT_FRAMES = 500
const GUARD_LIMIT_BYTES = 8 * 1024 * 1024

const COMPAT_BEFORE_FLIP = "2026-03-16"
const COMPAT_CURRENT = "2026-07-22"

type SocketSurface = {
  /** `"bufferedAmount" in socket` — the check a guard's truthiness depends on. */
  hasBufferedAmountProperty: boolean
  typeofBufferedAmount: string
  typeofGetBufferedAmount: string
  /** Every own property name up the prototype chain, so a failure says WHAT it found. */
  prototypeProperties: string[]
  constructorName?: string
}

type WorkerdReport = {
  surface: SocketSurface
  /** After queueing ~32 MiB at a peer that never reads. */
  bufferedAmountAfterOvershoot: unknown
  readyStateAfterOvershoot: number
  /** The literal `cloudflare.ts` guard expression, had it been written. */
  guardExpressionFires: boolean
}

/**
 * The socket stays inside workerd and the report comes back over plain HTTP,
 * for the same reason as `relay-workerd-binary.test.ts`: Bun's `ws` shim cannot
 * drive miniflare's WebSocket client. Keeping it in the runtime also means the
 * bytes cross a genuine workerd socket rather than a harness loopback.
 *
 * The client end of the pair is deliberately never returned or accepted, which
 * is what makes it a peer that never reads — exactly the condition the cloud
 * failure needed. It also means the report CANNOT travel over the socket under
 * test (the overshoot frames would arrive ahead of it), so it goes over HTTP.
 *
 * No bundler here — the fixture imports nothing from the package, because the
 * subject under test is the runtime's own WebSocket surface, not our code.
 */
const WORKERD_FIXTURE = `
const GUARD_LIMIT_BYTES = ${GUARD_LIMIT_BYTES}

const surfaceOf = (socket) => {
  const prototypeProperties = []
  let proto = Object.getPrototypeOf(socket)
  while (proto && proto !== Object.prototype) {
    prototypeProperties.push(...Object.getOwnPropertyNames(proto))
    proto = Object.getPrototypeOf(proto)
  }
  return {
    hasBufferedAmountProperty: "bufferedAmount" in socket,
    typeofBufferedAmount: typeof socket.bufferedAmount,
    typeofGetBufferedAmount: typeof socket.getBufferedAmount,
    prototypeProperties,
    constructorName: socket.constructor && socket.constructor.name,
  }
}

const report = (socket) => {
  const surface = surfaceOf(socket)
  // Queue far more than any drain could absorb, at a peer that never reads.
  const frame = "x".repeat(${OVERSHOOT_FRAME_BYTES})
  for (let i = 0; i < ${OVERSHOOT_FRAMES}; i++) {
    try { socket.send(frame) } catch { break }
  }
  return {
    surface,
    bufferedAmountAfterOvershoot: socket.bufferedAmount ?? null,
    readyStateAfterOvershoot: socket.readyState,
    // Exactly the shape W7.1a proposed for cloudflare.ts, verbatim semantics.
    guardExpressionFires: socket.bufferedAmount > GUARD_LIMIT_BYTES,
  }
}

export class BackpressureRoom {
  constructor(state) { this.state = state }

  async fetch(request) {
    const pair = new WebSocketPair()
    const server = pair[1]
    // Two ways the room accepts a socket in production. Both are measured,
    // because they are different code paths in workerd: hibernatable sockets are
    // owned by the runtime and survive eviction, listener sockets are not.
    if (new URL(request.url).searchParams.get("mode") === "hibernate") {
      this.state.acceptWebSocket(server)
    } else {
      server.accept()
    }
    // pair[0] is intentionally dropped: nothing ever accepts or reads it, so
    // everything sent below can only pile up in the runtime's send buffer.
    return Response.json(report(server))
  }

  async webSocketMessage() {}
  async webSocketClose() {}
}

export default {
  async fetch(request, env) {
    const mode = new URL(request.url).searchParams.get("mode") ?? "listener"
    return env.ROOM.get(env.ROOM.idFromName(mode)).fetch(
      new Request("https://relay.test/ws?mode=" + mode),
    )
  },
}
`

async function workerdSocketReport(input: {
  compatibilityDate: string
  mode: "listener" | "hibernate"
}): Promise<WorkerdReport> {
  return await withWorkerd(
    {
      modules: true,
      script: WORKERD_FIXTURE,
      compatibilityDate: input.compatibilityDate,
      durableObjects: { ROOM: { className: "BackpressureRoom", useSQLite: true } },
    },
    async (mf) => {
      const res = await mf.dispatchFetch(`http://relay.test/run?mode=${input.mode}`)
      const body = await res.json() as WorkerdReport & { error?: string }
      if (!res.ok || body.error) throw new Error(`fixture worker failed: ${body.error ?? res.status}`)
      return body
    },
  )
}

describe("real workerd WebSocket send-buffer surface", () => {
  for (const mode of ["listener", "hibernate"] as const) {
    test(`exposes no bufferedAmount on the ${mode} path`, async () => {
      const report = await workerdSocketReport({ compatibilityDate: COMPAT_CURRENT, mode })

      // The whole W7.1a fix shape rests on this being present. It is not.
      expect(report.surface.hasBufferedAmountProperty).toBe(false)
      expect(report.surface.typeofBufferedAmount).toBe("undefined")
      // Nor is there a method form, as Bun has.
      expect(report.surface.typeofGetBufferedAmount).toBe("undefined")
      expect(report.surface.prototypeProperties).not.toContain("bufferedAmount")
      expect(report.surface.prototypeProperties).not.toContain("getBufferedAmount")
      // Sanity: this IS the runtime WebSocket and the chain was really walked.
      expect(report.surface.constructorName).toBe("WebSocket")
      expect(report.surface.prototypeProperties).toContain("send")
      expect(report.surface.prototypeProperties).toContain("addEventListener")
    }, 180_000)
  }

  test("stays silent and OPEN with ~32 MiB queued at a peer that never reads", async () => {
    // The mechanism itself, as close as a local runtime can get: four times the
    // limit any guard would have used, and the isolate can see NOTHING — no
    // buffer depth, no state change, no throw. On the cloud it is at this point
    // that workerd eventually destroys the socket underneath us, which is why
    // the failure carried no logs and no exceptions.
    const report = await workerdSocketReport({ compatibilityDate: COMPAT_CURRENT, mode: "hibernate" })

    expect(report.bufferedAmountAfterOvershoot).toBeNull()
    expect(report.readyStateAfterOvershoot).toBe(1)
    // The proposed guard, run for real, over the limit: it does not fire.
    expect(report.guardExpressionFires).toBe(false)
  }, 180_000)

  test("exposes no bufferedAmount at the pre-flip compatibility date either", async () => {
    // Rules out "it is a compatibility-date-gated property", the one remaining
    // way the port could have been salvaged by configuration.
    const report = await workerdSocketReport({ compatibilityDate: COMPAT_BEFORE_FLIP, mode: "listener" })

    expect(report.surface.typeofBufferedAmount).toBe("undefined")
    expect(report.surface.typeofGetBufferedAmount).toBe("undefined")
  }, 180_000)

  test("@cloudflare/workers-types agrees that WebSocket has no bufferedAmount", async () => {
    // Belt and braces on the runtime probe: Cloudflare's own published types
    // never declare it. If a future version adds it, this fails alongside the
    // runtime tests and the port becomes possible.
    const types = await readFile(require.resolve("@cloudflare/workers-types"), "utf8")
    // Guard the guard: if the file moves, fail loudly rather than pass vacuously.
    const iface = types.match(/interface WebSocket extends EventTarget<WebSocketEventMap> \{[\s\S]*?\n\}/)?.[0]
    expect(iface).toBeDefined()
    // v5 types mention `bufferedAmount` in an MDN doc comment on send(); what
    // matters is that the interface never DECLARES it as a member.
    expect(iface).not.toMatch(/^\s*(readonly\s+)?(get\s+)?bufferedAmount\b/m)
    expect(iface).not.toMatch(/getBufferedAmount\s*\(/)
  })
})

describe("Bun ServerWebSocket send-buffer surface", () => {
  test("reports depth via getBufferedAmount(), not a bufferedAmount property", async () => {
    // The runtime fact that made the prior art dead code. `src/bun.ts` used to
    // read `(socket as { bufferedAmount?: number }).bufferedAmount!` at both
    // guard sites; the non-null assertion hid that the property does not exist,
    // so `undefined > 8388608` was false and neither "backpressure limit
    // exceeded" close had ever fired. Measured here on a real socket over the
    // limit — the old expression is evaluated verbatim to show it stays false.
    const measured = await new Promise<{
      realBufferedBytes: number
      whatTheOldGuardRead: unknown
      oldGuardExpressionFires: boolean
      prototypeProperties: string[]
    }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Bun socket never opened")), 10_000)
      const server = Bun.serve({
        port: 0,
        fetch(request, self) {
          if (self.upgrade(request)) return undefined
          return new Response("expected an upgrade", { status: 400 })
        },
        websocket: {
          open(socket) {
            const frame = "x".repeat(OVERSHOOT_FRAME_BYTES)
            for (let index = 0; index < OVERSHOOT_FRAMES; index++) socket.send(frame)
            const whatTheOldGuardRead = (socket as unknown as { bufferedAmount?: number }).bufferedAmount
            clearTimeout(timer)
            resolve({
              realBufferedBytes: socket.getBufferedAmount(),
              whatTheOldGuardRead,
              oldGuardExpressionFires: whatTheOldGuardRead! > GUARD_LIMIT_BYTES,
              prototypeProperties: Object.getOwnPropertyNames(Object.getPrototypeOf(socket)),
            })
          },
          message() {},
        },
      })
      const client = new WebSocket(`ws://localhost:${server.port}`)
      client.addEventListener("error", () => {
        clearTimeout(timer)
        reject(new Error("Bun client socket errored"))
      })
    })

    // The method exists and reports a real, over-limit depth...
    expect(measured.prototypeProperties).toContain("getBufferedAmount")
    expect(measured.realBufferedBytes).toBeGreaterThan(GUARD_LIMIT_BYTES)
    // ...while the property the old guard read does not exist at all.
    expect(measured.prototypeProperties).not.toContain("bufferedAmount")
    expect(measured.whatTheOldGuardRead).toBeUndefined()
    expect(measured.oldGuardExpressionFires).toBe(false)
  }, 30_000)

  test("bun.ts reads the method form at both guard sites", async () => {
    // Pins the fix so the property form cannot creep back in. The behavioural
    // assertions for the now-live guard (over-limit closes, fail-open on a
    // socket that cannot report) live in `bun.test.ts`.
    const bun = await readFile(new URL("./bun.ts", import.meta.url), "utf8")
    expect(bun).toContain("getBufferedAmount")
    expect(bun).not.toContain("{ bufferedAmount?: number }).bufferedAmount!")
    // Both guards go through the shared helper rather than reading a socket
    // accessor inline, which is what let the two sites drift into dead code.
    expect(bun).toContain("if (relayOverBackpressureLimit(channel,")
    expect(bun).toContain("if (relayOverBackpressureLimit(tunnel,")
  })

  test("cloudflare.ts carries no backpressure guard, because none is writable", async () => {
    // Not an oversight: the workerd tests above are the reason. If someone adds
    // a `bufferedAmount` read here, this fails and points them at those tests
    // rather than letting a permanent no-op ship as the cliff fix.
    const cloudflare = await readFile(new URL("./cloudflare.ts", import.meta.url), "utf8")
    expect(cloudflare).not.toContain("bufferedAmount")
    expect(cloudflare).not.toContain("getBufferedAmount")
  })
})
