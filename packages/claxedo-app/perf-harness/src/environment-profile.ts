import type { CDPSession } from "playwright-core"

/**
 * The hardware and network the app is measured ON.
 *
 * Every timing in this harness is a property of the machine as much as of the
 * code, and the container these run in is neither calibrated nor quiet. A named
 * profile makes that dependency explicit and reproducible: the numbers mean
 * "on THIS reference machine", and a result carries the profile that produced
 * it so two runs are never silently compared across different hardware.
 *
 * `cpuThrottlingRate` is a CDP slowdown multiplier applied to the renderer.
 * `downKbps`/`upKbps`/`rttMs` drive CDP network emulation.
 */
export type EnvironmentProfile = {
  id: string
  label: string
  cpuThrottlingRate: number
  downKbps: number
  upKbps: number
  rttMs: number
  /**
   * Latency added to MOCKED responses, which CDP network emulation cannot
   * reach (see `applyNetworkProfile`). Half the RTT each way approximates one
   * round trip for a request whose body is small enough that bandwidth does not
   * matter — which is every fixture response here.
   */
  mockLatencyMs: number
  /**
   * Multiplier for the harness's readiness timeouts. A throttled run is
   * legitimately slower, so a fixed 2s wait that passes unthrottled can fail
   * purely because the profile is doing its job — which reads as a crash, not
   * as a slow result.
   */
  timeoutScale: number
}

const kbps = (mbps: number) => Math.round(mbps * 1000)

export const ENVIRONMENT_PROFILES: Record<string, EnvironmentProfile> = {
  /**
   * The harness's historical behaviour: whatever the host happens to be. Kept
   * as the default so existing worst-frame budgets, captured unthrottled on
   * 2026-08-13, stay comparable to new runs.
   */
  unthrottled: {
    id: "unthrottled",
    label: "host machine, no emulation",
    cpuThrottlingRate: 1,
    downKbps: 0,
    upKbps: 0,
    rttMs: 0,
    mockLatencyMs: 0,
    timeoutScale: 1,
  },
  /**
   * The reference profile: a mid-range developer laptop on broadband.
   *
   * Chosen over Lighthouse's mobile preset because this app is an Electron
   * workbench and a web app for the same audience — it never runs on a phone,
   * so a phone's CPU and a 4G radio would model a user who does not exist. 4x
   * CPU slowdown is Lighthouse's multiplier, applied here to a laptop baseline
   * rather than a phone one; 10/3 Mbps at 40ms is ordinary home or office
   * broadband rather than a best-case fibre link.
   */
  "laptop-broadband": {
    id: "laptop-broadband",
    label: "mid-range laptop, broadband (4x CPU, 10/3 Mbps, 40ms RTT)",
    cpuThrottlingRate: 4,
    downKbps: kbps(10),
    upKbps: kbps(3),
    rttMs: 40,
    mockLatencyMs: 20,
    timeoutScale: 3,
  },
  /**
   * Lighthouse's standard mobile throttling, for a number directly comparable
   * to public Core Web Vitals and Lighthouse scores. Not the shape of this
   * app's real usage — use it to compare against the industry, not to gate.
   */
  "lighthouse-mobile": {
    id: "lighthouse-mobile",
    label: "Lighthouse mobile (4x CPU, Slow 4G)",
    cpuThrottlingRate: 4,
    downKbps: 1638,
    upKbps: 750,
    rttMs: 150,
    mockLatencyMs: 75,
    timeoutScale: 6,
  },
}

export const DEFAULT_PROFILE_ID = "unthrottled"

export function environmentProfile(id: string | undefined): EnvironmentProfile {
  const profile = ENVIRONMENT_PROFILES[id ?? DEFAULT_PROFILE_ID]
  if (!profile) {
    const known = Object.keys(ENVIRONMENT_PROFILES).join(", ")
    throw new Error(`unknown --profile "${id}". Known profiles: ${known}`)
  }
  return profile
}

/** CPU slowdown. A rate of 1 is a no-op, so the unthrottled profile costs nothing. */
export async function applyCpuProfile(cdp: CDPSession, profile: EnvironmentProfile) {
  if (profile.cpuThrottlingRate <= 1) return
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpuThrottlingRate })
}

/**
 * Network emulation.
 *
 * Reaches only requests that actually traverse the network stack. This harness
 * fulfils every API and SSE route in-process from fixtures (`route.fulfill`),
 * and a fulfilled response never leaves the client, so emulation cannot slow
 * it — `profile.mockLatencyMs` is what covers those. What emulation DOES shape
 * is the part that matters most for load vitals: the real asset requests that
 * fall through to the preview server, which is the whole JS/CSS bundle.
 *
 * Verified rather than assumed, because Playwright's interception plausibly
 * bypasses the network stack. Loading the real bundle at three bandwidths, with
 * `page.route("**\/*")` installed and falling through:
 *
 *   no emulation      FCP  296ms   load  299ms
 *   10Mbps / 40ms     FCP  700ms   load  760ms
 *   1.6Mbps / 150ms   FCP 3380ms   load 3818ms
 *   1.6Mbps / 150ms   FCP 3392ms   load 3890ms   (interception active)
 *
 * Throughput emulation clearly applies and interception does not defeat it.
 * The `latency` term is weaker: document TTFB stayed at 4-13ms on loopback in
 * every condition, so per-request RTT shows up in aggregate load time but not
 * on the first byte. Read TTFB here as a local-server artifact, not a vital.
 */
export async function applyNetworkProfile(cdp: CDPSession, profile: EnvironmentProfile) {
  if (profile.downKbps <= 0) return
  await cdp.send("Network.enable")
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: profile.rttMs,
    downloadThroughput: (profile.downKbps * 1000) / 8,
    uploadThroughput: (profile.upKbps * 1000) / 8,
  })
}
