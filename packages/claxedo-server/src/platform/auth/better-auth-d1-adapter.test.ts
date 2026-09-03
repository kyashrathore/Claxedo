import type { D1Database } from "@cloudflare/workers-types"
import { describe, expect, test, vi } from "vitest"

import {
  BETTER_AUTH_D1_ATOMIC,
  betterAuthD1Adapter,
  type BetterAuthD1AtomicCapability,
} from "./better-auth-d1-adapter"

function atomicCapability() {
  const batch = vi.fn()
  const database = { batch } as unknown as D1Database
  const adapter = betterAuthD1Adapter(database)({}) as unknown as {
    [BETTER_AUTH_D1_ATOMIC]: BetterAuthD1AtomicCapability
  }
  return { batch, capability: adapter[BETTER_AUTH_D1_ATOMIC] }
}

const user = {
  id: "user-1",
  name: "User One",
  email: "user@example.test",
  emailVerified: false,
  createdAt: new Date("2026-08-28T00:00:00Z"),
  updatedAt: new Date("2026-08-28T00:00:00Z"),
}

const account = {
  id: "account-1",
  accountId: user.id,
  providerId: "credential",
  issuer: "credential",
  userId: user.id,
  password: "hashed-password",
  createdAt: new Date("2026-08-28T00:00:00Z"),
  updatedAt: new Date("2026-08-28T00:00:00Z"),
}

describe("Better Auth D1 atomic identity capability", () => {
  test("rejects a hook-altered account user binding before issuing D1 statements", async () => {
    const { batch, capability } = atomicCapability()
    await expect(capability.createUserAccount(user, { ...account, userId: "different-user" }))
      .rejects.toThrow(/account\.userId must match/)
    expect(batch).not.toHaveBeenCalled()
  })

  test("rejects a hook-altered credential account id before issuing D1 statements", async () => {
    const { batch, capability } = atomicCapability()
    await expect(capability.createUserAccount(user, { ...account, accountId: "different-account" }))
      .rejects.toThrow(/credential accountId must match/)
    expect(batch).not.toHaveBeenCalled()
  })

  test("rejects missing canonical identity fields before issuing D1 statements", async () => {
    const { batch, capability } = atomicCapability()
    await expect(capability.createUserAccount({ ...user, id: "" }, account))
      .rejects.toThrow(/user\.id must be a non-empty string/)
    expect(batch).not.toHaveBeenCalled()
  })

  test("treats an ambiguously failed rotation whose family was concurrently deleted as stale", async () => {
    const batch = vi.fn().mockRejectedValue(new Error("ambiguous D1 transport failure"))
    const prepare = vi.fn((sql: string) => {
      const statement = {
        bind: vi.fn(() => statement),
        first: vi.fn(async () => sql.includes(`select "id"`) ? undefined : null),
      }
      return statement
    })
    const database = { batch, prepare } as unknown as D1Database
    const adapter = betterAuthD1Adapter(database)({}) as unknown as {
      [BETTER_AUTH_D1_ATOMIC]: BetterAuthD1AtomicCapability
    }
    const capability = adapter[BETTER_AUTH_D1_ATOMIC]
    const parent = { id: "refresh-parent", clientId: "claxedo-cli", familyId: "family-1", generation: 0 }
    const child = {
      id: "refresh-child",
      token: "hashed-child-token",
      clientId: parent.clientId,
      userId: "user-1",
      familyId: parent.familyId,
      parentId: parent.id,
      generation: 1,
      createdAt: new Date("2026-08-28T00:00:00Z"),
      expiresAt: new Date("2026-09-28T00:00:00Z"),
      scopes: "offline_access",
    }
    const rotatedAt = new Date("2026-08-28T00:00:01Z")
    await expect(capability.rotateRefreshToken(parent, child, {
      revoked: rotatedAt,
      rotatedAt,
      rotationNonce: "rotation-nonce-1",
    })).resolves.toBeUndefined()
    expect(batch).toHaveBeenCalledOnce()
  })
})
