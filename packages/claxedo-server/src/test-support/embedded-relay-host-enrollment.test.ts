import { expect, test } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { createSqliteWorkspaceAuthority } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority"
import { localHostIdentity } from "../workspace/local-host"
import { startEmbeddedRelayHostEnrollment } from "./embedded-relay-host-enrollment"

test("the embedded relay host serves its workspace under the fence the authority stored", async () => {
  const authority = createSqliteWorkspaceAuthority({ path: ":memory:" })
  const auth: SignedControlPlaneAuth = {
    mode: "signed",
    user: { subject: "fixture-owner", tokenIdentifier: "fixture|owner", issuer: "fixture" },
  }
  let serving: Awaited<ReturnType<typeof startEmbeddedRelayHostEnrollment>> | undefined
  try {
    await authority.registerLocalForSharing(auth, { workspaceId: "ws_fixture", displayName: "Fixture", remoteDirectory: "/fixture" })
    const identity = await localHostIdentity()
    serving = await startEmbeddedRelayHostEnrollment({
      authority,
      auth,
      identity,
      workspaceId: "ws_fixture",
      remoteDirectory: "/fixture",
      sessionAuthority: "managed-private",
      ttlMs: 60_000,
      intervalMs: 15_000,
    })
    const row = await authority.machineAuth!.lookupEnrollment(serving.fence.enrollmentId)
    expect(serving.fence).toEqual({ enrollmentId: row!.enrollment_id, generation: row!.serving_generation })
    expect(serving.fence.generation).toBeGreaterThan(0)
    await expect(authority.activeWorkspaceHost(auth, { workspaceId: "ws_fixture" })).resolves.toMatchObject({
      active: true,
      host_id: identity.hostId,
    })
  } finally {
    await serving?.stop()
    authority.close()
  }
})
