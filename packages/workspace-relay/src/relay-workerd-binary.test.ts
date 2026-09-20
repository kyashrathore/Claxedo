import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Miniflare } from "miniflare"
import { bootWorkerd, reapWorkerd } from "./workerd-fixture/boot"

/**
 * Real-workerd binary-frame round-trip; must pass before any
 * `compatibility_date` bump.
 *
 * Every other test in this package drives socket doubles, so none can observe
 * what workerd delivers as `event.data` for a binary frame — and that changes
 * with the compatibility date (miniflare 4.20260722.0 / workerd 1.20260722.1):
 *
 *   | delivery path                  | 2026-03-16  | 2026-03-17+ |
 *   | addEventListener("message")    | ArrayBuffer | Blob        |
 *   | webSocketMessage (hibernation) | ArrayBuffer | ArrayBuffer |
 *
 * Only the listener path flips. Production host-tunnel channels run the
 * hibernation path and cloud client/upstream sockets run the listener path, so
 * the exposure is the cloud path. This boots the real runtime and asserts the
 * decoders survive both shapes.
 */

const COMPAT_BEFORE_FLIP = "2026-03-16"
const COMPAT_AFTER_FLIP = "2026-03-17"
const COMPAT_CURRENT = "2026-07-22"

/** Every date this file measures — one hosted worker each, in the single boot. */
const COMPAT_DATES = [COMPAT_BEFORE_FLIP, COMPAT_AFTER_FLIP, COMPAT_CURRENT]

const PAYLOAD = new Uint8Array([0, 1, 0x7f, 0x80, 0xfe, 0xff])
const PAYLOAD_BASE64 = btoa(String.fromCharCode(...PAYLOAD))

type FrameReport = {
  runtimeType: string
  binaryType?: string
  frameDropped: boolean
  payloadDropped: boolean
  binary?: boolean
  dataBase64?: string
  payloadBase64?: string
}

let workDir: string
let mf: Miniflare

/**
 * Binding name (on the router) and worker name for one compatibility date.
 * `2026-03-16` → binding `COMPAT_2026_03_16`, worker `compat-2026-03-16`.
 */
const bindingFor = (date: string) => `COMPAT_${date.replaceAll("-", "_")}`
const workerFor = (date: string) => `compat-${date}`

/**
 * Entry worker: forwards the request, untouched, to the dated worker named by
 * the `x-target-date` header. It exists so ONE Miniflare boot can host every
 * compatibility date this file measures — see workerd-fixture/boot.ts for why
 * a second boot in the same bun process wedges on Linux. The router carries no
 * behavior of its own, so the dated workers see exactly the request the test
 * sent.
 */
const ROUTER_SCRIPT = `
export default {
  async fetch(request, env) {
    const date = request.headers.get("x-target-date")
    const target = date && env["COMPAT_" + date.replaceAll("-", "_")]
    if (!target) return Response.json({ error: "no worker hosts compatibility date " + date }, { status: 500 })
    return target.fetch(request)
  },
}
`

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "relay-workerd-"))
  const outfile = join(workDir, "worker.mjs")
  // Bundle the fixture so the REAL `socketFrame`/`socketPayload` from
  // cloudflare.ts run inside workerd — not a copy, not a re-implementation.
  // Run esbuild's JS entry under the current runtime with real filesystem
  // paths: URL.pathname renders /D:/... on Windows, and .bin/esbuild is a
  // POSIX launcher (Windows ships .cmd shims execFileSync cannot run).
  execFileSync(
    process.execPath,
    [
      fileURLToPath(import.meta.resolve("esbuild/bin/esbuild")),
      fileURLToPath(new URL("./workerd-fixture/binary-frame-worker.ts", import.meta.url)),
      "--bundle",
      "--format=esm",
      "--platform=neutral",
      "--target=es2022",
      `--outfile=${outfile}`,
    ],
    { stdio: "pipe" },
  )
  const bundle = await readFile(outfile, "utf8")

  // ONE boot for the whole file: the same bundle runs once per compatibility
  // date, as separate workers behind the router. Per-date boots wedge under
  // bun on Linux (see workerd-fixture/boot.ts).
  mf = await bootWorkerd({
    workers: [
      {
        name: "router",
        modules: true,
        script: ROUTER_SCRIPT,
        compatibilityDate: COMPAT_CURRENT,
        serviceBindings: Object.fromEntries(COMPAT_DATES.map((date) => [bindingFor(date), workerFor(date)])),
      },
      ...COMPAT_DATES.map((date) => ({
        name: workerFor(date),
        modules: true,
        script: bundle,
        compatibilityDate: date,
        durableObjects: { ROOM: { className: "BinaryFrameRoom", useSQLite: true } },
      })),
    ],
  })
}, 240_000)

afterAll(async () => {
  // `mf` is deliberately NOT disposed: under bun on Linux a dispose wedges
  // every later Miniflare boot in this process (the other workerd test file's
  // boot included). SIGKILLing the workerd children does not.
  reapWorkerd()
  if (workDir) await rm(workDir, { recursive: true, force: true })
})

/**
 * The WebSocket lives entirely inside workerd and the report comes back over
 * plain HTTP. Driving the socket from here instead would hang: Bun's `ws` shim
 * does not implement the `upgrade` event miniflare's client needs.
 */
async function sendBinaryFrame(input: {
  compatibilityDate: string
  mode: "listener" | "hibernate"
}): Promise<FrameReport> {
  const res = await mf.dispatchFetch(
    `http://relay.test/run?mode=${input.mode}&payload=${encodeURIComponent(PAYLOAD_BASE64)}`,
    { headers: { "x-target-date": input.compatibilityDate } },
  )
  const body = await res.json() as FrameReport & { error?: string }
  if (!res.ok || body.error) throw new Error(`fixture worker failed: ${body.error ?? res.status}`)
  return body
}

describe("real workerd binary frame round-trip", () => {
  test("decodes a binary frame on the listener path before the binaryType flip", async () => {
    const report = await sendBinaryFrame({ compatibilityDate: COMPAT_BEFORE_FLIP, mode: "listener" })

    expect(report.runtimeType).toBe("ArrayBuffer")
    expect(report.binaryType).toBe("arraybuffer")
    expect(report.frameDropped).toBe(false)
    expect(report.payloadDropped).toBe(false)
    expect(report.binary).toBe(true)
    expect(report.dataBase64).toBe(PAYLOAD_BASE64)
    expect(report.payloadBase64).toBe(PAYLOAD_BASE64)
  }, 180_000)

  test("decodes a Blob binary frame on the listener path after the flip", async () => {
    // Positive control: a decoder that ignores Blob reports
    // frameDropped/payloadDropped true here.
    const report = await sendBinaryFrame({ compatibilityDate: COMPAT_AFTER_FLIP, mode: "listener" })

    expect(report.runtimeType).toBe("Blob")
    expect(report.binaryType).toBe("blob")
    expect(report.frameDropped).toBe(false)
    expect(report.payloadDropped).toBe(false)
    expect(report.binary).toBe(true)
    expect(report.dataBase64).toBe(PAYLOAD_BASE64)
    expect(report.payloadBase64).toBe(PAYLOAD_BASE64)
  }, 180_000)

  test("decodes a binary frame on the listener path at the current compatibility date", async () => {
    const report = await sendBinaryFrame({ compatibilityDate: COMPAT_CURRENT, mode: "listener" })

    expect(report.runtimeType).toBe("Blob")
    expect(report.frameDropped).toBe(false)
    expect(report.dataBase64).toBe(PAYLOAD_BASE64)
    expect(report.payloadBase64).toBe(PAYLOAD_BASE64)
  }, 180_000)

  test("hibernation delivery stays an ArrayBuffer across the flip", async () => {
    // If a future workerd flips the hibernation path to Blob too, the exposure
    // extends to the host-tunnel channels; the decoders already handle Blob,
    // but wrangler.toml's comment would need updating.
    for (const compatibilityDate of [COMPAT_BEFORE_FLIP, COMPAT_AFTER_FLIP, COMPAT_CURRENT]) {
      const report = await sendBinaryFrame({ compatibilityDate, mode: "hibernate" })
      expect(report.runtimeType, `hibernation delivery at ${compatibilityDate}`).toBe("ArrayBuffer")
      expect(report.frameDropped).toBe(false)
      expect(report.dataBase64).toBe(PAYLOAD_BASE64)
    }
  }, 240_000)

  test("the deployed compatibility_date is still the pinned pre-flip value", async () => {
    // wrangler-h2.toml pins the same date and is checked too.
    for (const config of ["../wrangler.toml", "../wrangler-h2.toml"]) {
      const source = await readFile(new URL(config, import.meta.url), "utf8")
      const declared = source.match(/^compatibility_date = "([\d-]+)"$/m)?.[1]
      expect(declared, `${config} must declare compatibility_date`).toBeDefined()
      expect(declared! < COMPAT_AFTER_FLIP, `${config} is at ${declared}, past the binaryType flip`).toBe(true)
    }
  })
})
