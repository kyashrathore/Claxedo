import { describe, expect, test } from "bun:test"
import type { FrameCausalMetric, FrameMetric } from "../src/frame-sampler"
import {
  alreadyLoadedResourceRequestFailures,
  clickWarmupResourceRequestFailures,
  isolatedInteractionEvidenceFailures,
  isolatedInteractionMetricRows,
  isolatedInteractionResourceRequests,
  isolatedInteractionSettleFailures,
  ISOLATED_INTERACTION_TIMEOUT_MS,
} from "../src/isolated-interaction"

function fabricatedMetric(input: Partial<FrameMetric> = {}, causal?: Partial<FrameCausalMetric>): FrameMetric {
  return {
    label: "test",
    worstFrameMs: 12,
    p95FrameMs: 8,
    framesOver833: 1,
    framesOver1667: 0,
    sampleCount: 40,
    completionMs: 120,
    verdict: "amber",
    mainThreadTasksMs: [4, 6, 8],
    ...(causal
      ? {
          causal: {
            dom: {
              nodesBefore: 100,
              nodesAfter: 120,
              composedNodesBefore: 100,
              composedNodesAfter: 120,
              nodesAdded: 30,
              nodesRemoved: 10,
              attributesChanged: 5,
            },
            longAnimationFrames: [],
            longTasks: [],
            events: [],
            resources: [],
            performance: { scriptMs: 10, recalcStyleMs: 4, layoutMs: 3, taskMs: 20 },
            performanceSource: "trusted-window-trace",
            ...causal,
          },
        }
      : {}),
    ...input,
  }
}

describe("isolated interaction shared gates", () => {
  test("standard bundle reports ack, completion, causal attribution, strict >16.67ms count, and resources", () => {
    const metric = fabricatedMetric({ framesOver1667: 3 }, {
      resources: [
        { name: "http://127.0.0.1/api/wr/diff/vcs", startTime: 1, initiatorType: "fetch", duration: 4, transferSize: 2_000, decodedBodySize: 4_000 },
        { name: "data:image/png;base64,x", startTime: 2, initiatorType: "img", duration: 0, transferSize: 0, decodedBodySize: 10 },
      ],
    })
    const rows = isolatedInteractionMetricRows("phase", metric, { completionMs: 120, acknowledgedMs: 16, timedOut: false })
    const byName = new Map(rows.map((row) => [row.metric, row.value]))
    expect(byName.get("phase_ack_ms")).toBe(16)
    expect(byName.get("phase_completion_ms")).toBe(120)
    expect(byName.get("phase_script_ms")).toBe(10)
    expect(byName.get("phase_style_ms")).toBe(4)
    expect(byName.get("phase_layout_ms")).toBe(3)
    expect(byName.get("phase_renderer_intervals_over_16_67_ms")).toBe(3)
    expect(byName.get("phase_renderer_interval_samples")).toBe(40)
    // data: URIs are not requests; the mocked API fetch is.
    expect(byName.get("phase_resource_requests")).toBe(1)
    expect(byName.get("phase_nodes_added")).toBe(30)
  })

  test("resource requests are undefined without causal capture, never silently zero", () => {
    expect(isolatedInteractionResourceRequests(fabricatedMetric())).toBeUndefined()
    expect(isolatedInteractionResourceRequests(fabricatedMetric({}, {}))).toBe(0)
  })

  test("hard zero-request gate fails on unobserved and on nonzero counts", () => {
    expect(alreadyLoadedResourceRequestFailures("phase", 0)).toEqual([])
    expect(alreadyLoadedResourceRequestFailures("phase", undefined)).toEqual([
      expect.stringContaining("unobserved"),
    ])
    expect(alreadyLoadedResourceRequestFailures("phase", 2)).toEqual([
      expect.stringContaining("issued 2 resource requests"),
    ])
  })

  test("click-warmup gate allows the budgeted warm-up and fails beyond it", () => {
    expect(clickWarmupResourceRequestFailures("phase", 0, 1)).toEqual([])
    expect(clickWarmupResourceRequestFailures("phase", 1, 1)).toEqual([])
    expect(clickWarmupResourceRequestFailures("phase", undefined, 1)).toEqual([
      expect.stringContaining("unobserved"),
    ])
    expect(clickWarmupResourceRequestFailures("phase", 2, 1)).toEqual([
      expect.stringContaining("expected at most 1"),
    ])
  })

  test("evidence gate fails without causal capture, without trusted-window trace, and without renderer tasks", () => {
    expect(isolatedInteractionEvidenceFailures("phase", fabricatedMetric({}, {}))).toEqual([])
    expect(isolatedInteractionEvidenceFailures("phase", fabricatedMetric())).toEqual([
      expect.stringContaining("CLAXEDO_PERF_CAUSAL=1"),
    ])
    expect(
      isolatedInteractionEvidenceFailures(
        "phase",
        fabricatedMetric({}, { performance: undefined, performanceSource: undefined, performanceUnavailableReason: "no CrRendererMain" }),
      ),
    ).toEqual([expect.stringContaining("no CrRendererMain")])
    expect(
      isolatedInteractionEvidenceFailures("phase", fabricatedMetric({ mainThreadTasksMs: [] }, {})),
    ).toEqual([expect.stringContaining("no renderer task samples")])
  })

  test("settle gate fails on a missing acknowledgement or a readiness timeout", () => {
    expect(isolatedInteractionSettleFailures("phase", { completionMs: 100, acknowledgedMs: 8, timedOut: false })).toEqual([])
    expect(isolatedInteractionSettleFailures("phase", { completionMs: 100, timedOut: false })).toEqual([
      expect.stringContaining("acknowledgement"),
    ])
    expect(
      isolatedInteractionSettleFailures("phase", {
        completionMs: ISOLATED_INTERACTION_TIMEOUT_MS,
        acknowledgedMs: 8,
        timedOut: true,
      }),
    ).toEqual([expect.stringContaining("did not settle")])
  })
})
