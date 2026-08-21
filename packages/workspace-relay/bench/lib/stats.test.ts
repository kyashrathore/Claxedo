import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { evaluateGates, markdownRow, shapeLabel, type RowMetrics } from "./stats"

/**
 * Regression coverage for the bench's own reporting, driven by a real failure.
 *
 * `bench/reports/dialin-100k-msgs-2026-07-17T20-59-47-113Z.json` recorded a p99
 * WS overhead of **-8972.69 ms** after all 50 connections closed and 22 of
 * 100,000 messages arrived. Overhead is relayed − direct, so a negative value
 * claims the relayed path beat a direct connection by nine seconds.
 *
 * Two reporting bugs made that run unreadable for two weeks:
 *   1. The latency gate PASSED on it — a nonsense negative compares as "less
 *      than the 100ms gate", and a non-finite value short-circuited to `true`.
 *      Only the zero-loss gate failed, so the cause looked like plain slowness.
 *   2. The close REASON was discarded, so the report said `1006×50` while the
 *      relay had been naming the exact guard that fired.
 */

const base: Omit<RowMetrics, "gates"> = {
  rowId: "row", shape: "c50x2000",
  target: "https://target.test", relay: "https://relay.test",
  httpP99OverheadMs: 9.3,
  wsMessageP99OverheadMs: 46.18,
  relayedWsMessages: { attempted: 10_000, delivered: 10_000 },
  directWsMessages: { attempted: 10_000, delivered: 10_000 },
  connectP95Ms: 24.62,
  upstreamOpenP95Ms: 40.41,
  upstreamOpenSource: "relay-trace",
  holderSetup: { attempted: 50, delivered: 50 },
  upstreamFailureCodes: {},
  upstreamFailureReasons: {},
}

describe("bench gate evaluation", () => {
  test("a healthy run is measurable and passes", () => {
    const gates = evaluateGates(base)
    expect(gates.latencyMeasurable).toBe(true)
    expect(gates.pass).toBe(true)
  })

  test("the historical dialin-100k collapse is unmeasurable, not merely slow", () => {
    const gates = evaluateGates({
      ...base,
      httpP99OverheadMs: Number.NaN,
      wsMessageP99OverheadMs: -8972.69,
      relayedWsMessages: { attempted: 100_000, delivered: 22 },
      directWsMessages: { attempted: 100_000, delivered: 100_000 },
      upstreamFailureCodes: { "1006": 50 },
      upstreamFailureReasons: { "Upstream WebSocket queue limit exceeded": 50 },
    })
    expect(gates.latencyMeasurable).toBe(false)
    // The specific regression: this was TRUE before, so the run's only visible
    // failure was message loss and the latency looked fine.
    expect(gates.wsMessageP99OverheadPass).toBe(false)
    expect(gates.pass).toBe(false)
  })

  test("a negative overhead is rejected even when delivery looks complete", () => {
    // Overhead is relayed − direct over the same network. Below zero is not a
    // fast relay, it is a broken measurement.
    expect(evaluateGates({ ...base, wsMessageP99OverheadMs: -0.5 }).latencyMeasurable).toBe(false)
  })

  test("percentiles over a small surviving fraction are rejected", () => {
    expect(evaluateGates({
      ...base,
      relayedWsMessages: { attempted: 10_000, delivered: 5_000 },
    }).latencyMeasurable).toBe(false)
  })

  test("ordinary jitter still measures — the guard is for collapse, not loss", () => {
    const gates = evaluateGates({
      ...base,
      relayedWsMessages: { attempted: 10_000, delivered: 9_990 },
    })
    expect(gates.latencyMeasurable).toBe(true)
    // Still fails overall: zero-loss is its own gate and is unaffected.
    expect(gates.zeroRelayedWsLossPass).toBe(false)
  })

  test("an empty run cannot be measured", () => {
    expect(evaluateGates({
      ...base,
      relayedWsMessages: { attempted: 0, delivered: 0 },
    }).latencyMeasurable).toBe(false)
  })
})

describe("bench markdown row", () => {
  test("prints the diagnosis and the close reason instead of a nonsense latency", () => {
    const row: Omit<RowMetrics, "gates"> = {
      ...base,
      wsMessageP99OverheadMs: -8972.69,
      relayedWsMessages: { attempted: 100_000, delivered: 22 },
      upstreamFailureCodes: { "1006": 50 },
      upstreamFailureReasons: { "Upstream WebSocket queue limit exceeded": 50 },
    }
    const rendered = markdownRow({ ...row, gates: evaluateGates(row) })

    expect(rendered).toContain("unmeasurable")
    expect(rendered).not.toContain("-8972")
    // The whole point: the row names the guard that killed the connections.
    expect(rendered).toContain("Upstream WebSocket queue limit exceeded×50")
    expect(rendered).toContain("FAIL")
  })

  test("a healthy row still prints its latency", () => {
    const rendered = markdownRow({ ...base, gates: evaluateGates(base) })
    expect(rendered).toContain("46.18ms")
    expect(rendered).toContain("PASS")
  })
})

/**
 * W7.2 — the CI gate override.
 *
 * The gate thresholds are read from the environment once, at module load, so a
 * shared CI runner can raise a latency bound whose jitter is not a property of
 * the relay. That is a loaded footgun if it can be used to silence a real
 * regression, so these pin the three properties that keep it honest:
 *
 *   1. Absent env => the RUNBOOK numbers (100 ms). The default is the contract.
 *   2. A malformed or non-positive override is IGNORED, not obeyed. `=0` must
 *      never mean "gate disabled".
 *   3. No override exists for message loss. "Zero loss" does not degrade with
 *      runner noise, so there is nothing to relax.
 *
 * Each runs in a subprocess because the constants are captured at import.
 */
describe("bench gate env overrides (W7.2 CI wiring)", () => {
  async function gatesUnder(env: Record<string, string>): Promise<{ http: number; ws: number }> {
    const proc = Bun.spawn({
      cmd: [
        process.execPath,
        "-e",
        'import("./bench/lib/stats.ts").then((m) => console.log(JSON.stringify({'
        + " http: m.HTTP_P99_OVERHEAD_GATE_MS, ws: m.WS_P99_OVERHEAD_GATE_MS })))",
      ],
      // fileURLToPath, not URL.pathname — the latter renders /D:/... on Windows.
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    })
    const out = await new Response(proc.stdout).text()
    const err = await new Response(proc.stderr).text()
    if ((await proc.exited) !== 0) throw new Error(`gate probe failed: ${err}`)
    return JSON.parse(out.trim())
  }

  test("with no override the RUNBOOK gates apply", async () => {
    expect(await gatesUnder({
      CLAXEDO_BENCH_HTTP_P99_GATE_MS: "",
      CLAXEDO_BENCH_WS_P99_GATE_MS: "",
    })).toEqual({ http: 100, ws: 100 })
  })

  test("an override raises only the gate it names", async () => {
    // The CI workflow raises HTTP and leaves WS strict; assert that asymmetry is
    // expressible, because a single knob for both would relax the gate with 46x
    // headroom for the sake of the one with 10x.
    expect(await gatesUnder({ CLAXEDO_BENCH_HTTP_P99_GATE_MS: "250" }))
      .toEqual({ http: 250, ws: 100 })
  })

  test("a zero, negative, or unparseable override cannot disable a gate", async () => {
    for (const value of ["0", "-1", "not-a-number", "  "]) {
      expect(
        await gatesUnder({ CLAXEDO_BENCH_HTTP_P99_GATE_MS: value }),
        `override "${value}" must fall back to the strict default`,
      ).toEqual({ http: 100, ws: 100 })
    }
  })

  test("message loss has no override: a lossy row fails under any env", () => {
    // Not a subprocess test — there is deliberately no env var to try.
    const lossy: Omit<RowMetrics, "gates"> = {
      ...base,
      relayedWsMessages: { attempted: 10_000, delivered: 9_999 },
    }
    expect(evaluateGates(lossy).zeroRelayedWsLossPass).toBe(false)
    expect(evaluateGates(lossy).pass).toBe(false)
  })
})

/**
 * The shape label must distinguish runs that differ in LOAD, not just in
 * connection count.
 *
 * `c20/load20` was the label on both an 80-message smoke row (WS p99 ~2 ms) and
 * a 40,000-message stress row (WS p99 66–81 ms — inside the 100 ms gate, but
 * only ~1.3x under it). Anyone reading `bench/reports/` to pick a gate baseline
 * saw one label covering two runs ~500x apart in message volume. That is a
 * measurement-integrity bug, not cosmetics.
 */
describe("bench shape label", () => {
  test("the two runs the old label conflated are now distinguishable", () => {
    const smoke = shapeLabel({ concurrency: 20, wsMessagesPerConnection: 4 })
    const stress = shapeLabel({ concurrency: 20, wsMessagesPerConnection: 2_000 })

    // The regression: both of these used to render "c20/load20".
    expect(smoke).not.toBe(stress)
    expect(smoke).toBe("c20/load20/m4")
    expect(stress).toBe("c20/load20/m2000")
  })

  test("connections defaults to concurrency but is honored when they differ", () => {
    expect(shapeLabel({ concurrency: 20, wsMessagesPerConnection: 4 })).toBe("c20/load20/m4")
    expect(shapeLabel({ concurrency: 10, wsMessagesPerConnection: 4, connections: 50 }))
      .toBe("c10/load50/m4")
  })

  test("the label survives into the rendered report row", () => {
    // A label nothing prints would be a label nobody reads.
    const row = { ...base, shape: shapeLabel({ concurrency: 50, wsMessagesPerConnection: 2_000 }) }
    expect(markdownRow({ ...row, gates: evaluateGates(row) })).toContain("c50/load50/m2000")
  })
})
