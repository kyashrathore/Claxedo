import { describe, expect, test } from "bun:test"
import {
  DEFAULT_RELAY_LOCATION_HINT,
  relayLocationHint,
  relayRequestRegion,
} from "@claxedo/workspace-relay"
import { startWorkspaceRelayHostTunnel } from "./workspace-relay-host-tunnel"

/**
 * End-to-end contract for the relay Durable Object location hint (W6b.3).
 *
 * The two halves live in different packages and deploy independently: the
 * runtime composes the host-tunnel URL, and the relay reads a region off the
 * request to decide where to create the workspace's Durable Object. A DO's
 * location is fixed at FIRST CREATION and never migrates, so if these two halves
 * disagree the workspace is permanently mis-placed and every frame pays an extra
 * ocean crossing for the life of the workspace.
 *
 * Unit tests on either side cannot catch a disagreement — they would each assert
 * their own half of the convention. This test spans the seam: it takes the URL
 * the runtime actually produces and feeds it to the relay's actual derivation.
 *
 * It also pins BOTH deployment-skew directions, since relay and runtime ship
 * separately:
 *  - new runtime → old relay: the param is ignored (an old relay reads only
 *    `workspaceId`/`workspace_id` from the tunnel query), so sending is safe;
 *  - old runtime → new relay: the param is absent and the relay falls back to
 *    its configured deployment hint.
 */

/** The URL the runtime really builds, captured from the WebSocket constructor. */
function hostTunnelUrl(input: { region?: string; workspaceIds?: string[] }) {
  let captured: string | undefined
  const tunnel = startWorkspaceRelayHostTunnel({
    relayUrl: "http://relay.invalid",
    hostId: "host_1",
    workspaceIds: input.workspaceIds ?? ["ws_1"],
    localBaseUrl: "http://runtime.invalid",
    ...(input.region !== undefined ? { region: input.region } : {}),
    webSocket: class {
      constructor(url: string) {
        captured = url
      }
      addEventListener() {}
      removeEventListener() {}
      send() {}
      close() {}
      readyState = 0
    } as never,
  })
  tunnel.close()
  if (!captured) throw new Error("host tunnel did not open a WebSocket")
  // The relay receives this as an HTTP(S) request; ws:// is the wire scheme.
  return new Request(captured.replace(/^ws/, "http"))
}

describe("relay location hint, runtime to relay", () => {
  test("a non-default region reaches the relay and derives its hint", async () => {
    // The headline case: a European workspace must not be pinned to the APAC
    // default just because that is the deployment-wide floor.
    const request = hostTunnelUrl({ region: "eu-west" })

    expect(relayRequestRegion(request)).toBe("eu-west")
    expect(relayLocationHint({ region: relayRequestRegion(request) })).toBe("weur")
  })

  test("every canonical region survives the round trip", async () => {
    // Values from DEFAULT_CLAXEDO_REGIONS (claxedo-server/src/region/index.ts) —
    // the set a workspace's homeRegion is validated against.
    const expected: Record<string, string> = {
      "apac-south": "apac",
      "apac-east": "apac",
      "eu-west": "weur",
      "us-east": "enam",
      "us-west": "wnam",
    }
    for (const [region, hint] of Object.entries(expected)) {
      const request = hostTunnelUrl({ region })
      expect(relayRequestRegion(request), `region ${region}`).toBe(region)
      expect(
        relayLocationHint({ region: relayRequestRegion(request) }),
        `region ${region} should map to ${hint}`,
      ).toBe(hint)
    }
  })

  test("an old runtime that sends no region falls back to the configured hint", async () => {
    // Backwards skew: relay upgraded first. Absence must be inert, not an error
    // and not an empty-string region.
    const request = hostTunnelUrl({})

    expect(relayRequestRegion(request)).toBeUndefined()
    expect(relayLocationHint({ region: relayRequestRegion(request) })).toBe(DEFAULT_RELAY_LOCATION_HINT)
    expect(relayLocationHint({
      region: relayRequestRegion(request),
      configured: "wnam",
    })).toBe("wnam")
  })

  test("the region param does not disturb the existing tunnel contract", async () => {
    // Forwards skew: runtime upgraded first, relay is old. An old relay parses
    // the path and the workspaceId params; the extra param must not change
    // either, or the tunnel fails to admit and remote access breaks outright.
    const withRegion = new URL(hostTunnelUrl({ region: "eu-west", workspaceIds: ["ws_1", "ws_2"] }).url)
    const without = new URL(hostTunnelUrl({ workspaceIds: ["ws_1", "ws_2"] }).url)

    expect(withRegion.pathname).toBe(without.pathname)
    expect(withRegion.searchParams.getAll("workspaceId")).toEqual(["ws_1", "ws_2"])
    expect(withRegion.searchParams.getAll("workspaceId")).toEqual(without.searchParams.getAll("workspaceId"))
    // Exactly one new key, nothing else moved.
    expect([...new Set(withRegion.searchParams.keys())].toSorted()).toEqual(["region", "workspaceId"])
    expect([...new Set(without.searchParams.keys())].toSorted()).toEqual(["workspaceId"])
  })

  test("an unknown region falls back rather than reaching Cloudflare", async () => {
    // Cloudflare REJECTS an unrecognised locationHint and a rejected get() fails
    // the request, so a stale/self-hosted region name must degrade to the default
    // rather than be passed through.
    const request = hostTunnelUrl({ region: "mars-central-1" })

    expect(relayRequestRegion(request)).toBe("mars-central-1")
    expect(relayLocationHint({ region: relayRequestRegion(request), configured: "wnam" })).toBe("wnam")
  })
})
