import { expect, test, vi } from "vitest"
import { D1SessionAuthority } from "./session-authority"
import type { D1Database } from "@cloudflare/workers-types"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"

test.each([true, false])("runtime intakeReady=%s does not reject a replay or change its turn lease", async (intakeReady) => {
  const database = { prepare: vi.fn() } as unknown as D1Database
  const authority = new D1SessionAuthority(database, { deploymentId: "test" })
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("[]"))))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("")
  const current = { session_id: "ses", workspace_id: "ws", deleted_at: null, max_event_ordinal: 7, snapshot_hash: hash }
  const internal = authority as unknown as {
    requirePrincipal: () => Promise<unknown>
    requireSessionAccess: () => Promise<unknown>
    session: () => Promise<unknown>
    turnLease: () => Promise<unknown>
  }
  vi.spyOn(internal, "requirePrincipal").mockResolvedValue({ actorId: "actor" })
  vi.spyOn(internal, "requireSessionAccess").mockResolvedValue(current)
  vi.spyOn(internal, "session").mockResolvedValue(current)
  const lease = vi.spyOn(internal, "turnLease").mockResolvedValue({ workspace_id: "ws", fencing_token: 3 })
  await expect(authority.syncSessionMessages({ mode: "signed" } as SignedControlPlaneAuth, {
    sessionId: "ses", workspaceId: "ws", messages: [], updatedAt: 200,
    maxEventOrdinal: 7, fencingToken: 3, intakeReady,
  })).resolves.toEqual({ ok: true, applied: false, maxEventOrdinal: 7 })
  expect(lease).toHaveBeenCalledTimes(1)
  expect(database.prepare).not.toHaveBeenCalled()
})
