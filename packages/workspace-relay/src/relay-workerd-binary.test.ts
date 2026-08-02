import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { withWorkerd } from "./workerd-fixture/boot"

/**
 * The REAL-workerd binary round-trip the plan requires before any
 * `compatibility_date` bump (W6.1).
 *
 * Every other test in this package drives hand-rolled socket doubles, which
 * hand the room whatever the test chose to hand it — so they cannot observe the
 * thing that actually breaks: what *workerd* delivers as `event.data` for a
 * binary frame changes with the compatibility date. This boots the real runtime
 * and asserts the decoders survive both shapes.
 *
 * MEASURED HERE (miniflare 4.20260722.0 / workerd 1.20260722.1, this file's own
 * assertions), and it CORRECTS the comment in wrangler.toml:
 *
 *   | delivery path                  | 2026-03-16  | 2026-03-17+ |
 *   | addEventListener("message")    | ArrayBuffer | Blob        |
 *   | webSocketMessage (hibernation) | ArrayBuffer | ArrayBuffer |
 *
 * The flip is real and lands exactly at 2026-03-17 — but ONLY on the
 * `addEventListener` path. The hibernation `webSocketMessage` path still
 * delivers an ArrayBuffer at every date tested, including 2026-07-22. The
 * wrangler.toml comment claims the hibernatable DO socket flips too; that is not
 * what the runtime does. This matters because production user-hosted channels
 * run the hibernation path, and the cloud client/upstream sockets run the
 * listener path — so the exposure was the CLOUD path, not the hibernating one.
 *
 * `compatibility_date` is deliberately NOT bumped by this change. This test is
 * the evidence that would let someone bump it later.
 */

const COMPAT_BEFORE_FLIP = "2026-03-16"
const COMPAT_AFTER_FLIP = "2026-03-17"
const COMPAT_CURRENT = "2026-07-22"

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

let bundle: string
let workDir: string

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "relay-workerd-"))
  const outfile = join(workDir, "worker.mjs")
  // Bundle the fixture so the REAL `socketFrame`/`socketPayload` from
  // cloudflare.ts run inside workerd — not a copy, not a re-implementation.
  execFileSync(
    new URL("../node_modules/.bin/esbuild", import.meta.url).pathname,
    [
      new URL("./workerd-fixture/binary-frame-worker.ts", import.meta.url).pathname,
      "--bundle",
      "--format=esm",
      "--platform=neutral",
      "--target=es2022",
      `--outfile=${outfile}`,
    ],
    { stdio: "pipe" },
  )
  bundle = await readFile(outfile, "utf8")
}, 240_000)

afterAll(async () => {
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
  return await withWorkerd(
    {
      modules: true,
      script: bundle,
      compatibilityDate: input.compatibilityDate,
      durableObjects: { ROOM: { className: "BinaryFrameRoom", useSQLite: true } },
    },
    async (mf) => {
      const res = await mf.dispatchFetch(
        `http://relay.test/run?mode=${input.mode}&payload=${encodeURIComponent(PAYLOAD_BASE64)}`,
      )
      const body = await res.json() as FrameReport & { error?: string }
      if (!res.ok || body.error) throw new Error(`fixture worker failed: ${body.error ?? res.status}`)
      return body
    },
  )
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
    // THE positive control for W6.1. Against pre-fix `socketFrame`/`socketPayload`
    // this reports frameDropped/payloadDropped true — the silent drop, on real
    // workerd, at the date Cloudflare will eventually force.
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
    // Pins the correction to the wrangler.toml comment. If a future workerd DOES
    // flip the hibernation path to Blob, this test fails and the person reading
    // it learns the exposure moved to the user-hosted channels — which is
    // information the fix already covers, but the comment would then be wrong
    // in the other direction.
    for (const compatibilityDate of [COMPAT_BEFORE_FLIP, COMPAT_AFTER_FLIP, COMPAT_CURRENT]) {
      const report = await sendBinaryFrame({ compatibilityDate, mode: "hibernate" })
      expect(report.runtimeType, `hibernation delivery at ${compatibilityDate}`).toBe("ArrayBuffer")
      expect(report.frameDropped).toBe(false)
      expect(report.dataBase64).toBe(PAYLOAD_BASE64)
    }
  }, 240_000)

  test("the deployed compatibility_date is still the pinned pre-flip value", async () => {
    // Guards the plan's hard constraint: the Blob fix lands WITHOUT a date bump.
    // Both configs are checked; wrangler-h2.toml pins the same date and was
    // previously outside every drift guard.
    for (const config of ["../wrangler.toml", "../wrangler-h2.toml"]) {
      const source = await readFile(new URL(config, import.meta.url), "utf8")
      const declared = source.match(/^compatibility_date = "([\d-]+)"$/m)?.[1]
      expect(declared, `${config} must declare compatibility_date`).toBeDefined()
      expect(declared! < COMPAT_AFTER_FLIP, `${config} is at ${declared}, past the binaryType flip`).toBe(true)
    }
  })
})
