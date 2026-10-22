import { describe, expect, test } from "bun:test"
import type { HostState } from "@claxedo/host-connector/host-state"
import { statusLines, type StatusDeps } from "./status"

function state(ownerDisplay: string): HostState {
  return {
    host_id: "host_1",
    private_key_jwk: { kty: "EC", crv: "P-256", x: "AQ", y: "AQ" },
    created_at: 1,
    control_plane_url: "https://cp.example.test",
    enrollment: {
      enrollment_id: "enr_1",
      owner_display: ownerDisplay,
      org_id: "org_1",
      enrolled_via: "invitation",
      enrolled_at: 2,
      key_version: 1,
    },
    cli_roots: [],
    storage_root: "/var/lib/claxedo",
  }
}

function deps(current: HostState): StatusDeps {
  return {
    load: async () => current,
    stateFile: "/state.json",
    resolvePath: async (target) => target,
    pidAlive: () => false,
    now: () => 10,
    log: () => undefined,
  }
}

describe("claxedo status run lines", () => {
  test("a paused machine reads as paused, not online, while its last lease is still current", async () => {
    const paused = { ...state("Alice"), run: { pid: 42, started_at: 1, generation: 1, last_beat_ok_at: 5, lease_expires_at: 60, paused_at: 8 } }
    const lines = await statusLines({ ...deps(paused), pidAlive: () => true })
    expect(lines).toContain("  status       paused by the owner at 1970-01-01T00:00:00.008Z; nothing is served until the owner resumes this machine in the app")
  })
})

describe("claxedo status enrollment line", () => {
  test("names the owner when the control plane reported one", async () => {
    const lines = await statusLines(deps(state("Alice")))
    expect(lines).toContain("  enrollment   enr_1 (via invitation, owner Alice)")
  })

  test("omits the owner clause when the redeem carried no display name", async () => {
    const lines = await statusLines(deps(state("")))
    expect(lines).toContain("  enrollment   enr_1 (via invitation)")
    expect(lines.join("\n")).not.toContain("owner")
  })
})
