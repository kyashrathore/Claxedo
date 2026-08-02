import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto"
import { afterEach, describe, expect, test, vi } from "vitest"
import { convexTest } from "convex-test"
import { api } from "./_generated/api"
import schema from "./schema"

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>
  }
}

const modules = import.meta.glob("./**/*.ts")

/**
 * Every table here requires `created_at`/`updated_at`. The hand-rolled `db`
 * double this suite used to run against enforced nothing, so its seeds were
 * missing them (and, for `local_host_links`, its required `last_seen_at` /
 * `expires_at`) and the schema drift went unnoticed.
 */
const stamped = <T extends Record<string, unknown>>(row: T) => ({ created_at: 1, updated_at: 1, ...row })

function hostKey() {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" })
  const privateKey = pair.privateKey.export({ format: "jwk" })
  const publicKey = JSON.stringify(pair.publicKey.export({ format: "jwk" }))
  return {
    publicKey,
    sign(payload: string) {
      return sign("sha256", Buffer.from(payload), {
        key: createPrivateKey({ key: privateKey, format: "jwk" }),
        dsaEncoding: "ieee-p1363",
      }).toString("base64url")
    },
  }
}

function registrationPayload(input: { workspaceId: string; hostId: string; challengeId: string; nonce: string }) {
  return [
    "claxedo.local-host-link.register.v1",
    `workspace_id=${input.workspaceId}`,
    `host_id=${input.hostId}`,
    `challenge_id=${input.challengeId}`,
    `nonce=${input.nonce}`,
  ].join("\n")
}

function heartbeatPayload(input: { workspaceId: string; hostId: string; ttlMs?: number }) {
  return [
    "claxedo.local-host-link.heartbeat.v1",
    `workspace_id=${input.workspaceId}`,
    `host_id=${input.hostId}`,
    `ttl_ms=${input.ttlMs ?? ""}`,
  ].join("\n")
}

afterEach(() => {
  vi.restoreAllMocks()
})

function asOwner(t: ReturnType<typeof convexTest>) {
  return t.withIdentity({ tokenIdentifier: "owner_token", subject: "owner_subject" })
}

/**
 * Local Host Link attestation and pause policy (`convex/localHostLinks.ts`).
 *
 * Runs against the real function pipeline via `convex-test` — including the
 * `authedMutation`/`serviceQuery` wrappers from `model.ts`. The previous
 * version of this suite lived in claxedo-server, imported `localHostLinks.ts`
 * and `workspaces.ts` across five directory levels, reached past the builders
 * into `_handler`, and drove a hand-written `db` double — so it exercised the
 * handler bodies while skipping the auth wrappers and `requireControlPlaneService`
 * check that make them safe.
 */
describe("Convex Local Host Link pause policy", () => {
  test("requires host key attestation for register and heartbeat", async () => {
    vi.spyOn(Date, "now").mockReturnValue(123_456)
    const key = hostKey()
    const t = convexTest(schema, modules)
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", stamped({ token_identifier: "owner_token" }) as never))
    await t.run(async (ctx) =>
      ctx.db.insert(
        "workspaces",
        stamped({
          workspace_id: "ws_1",
          owner_user_id: ownerId,
          backing: "local-worktree",
          access: "user-hosted",
          display_name: "Workspace 1",
          home_region: "eu-west",
        }) as never,
      ),
    )
    const owner = asOwner(t)

    const challenge = (await owner.mutation(api.localHostLinks.createChallenge, {
      workspace_id: "ws_1",
      host_id: "host_1",
    } as never)) as { challenge_id: string; nonce: string; expires_at: number }

    await expect(
      owner.mutation(api.localHostLinks.register, {
        workspace_id: "ws_1",
        host_id: "host_1",
        public_key: key.publicKey,
        challenge_id: challenge.challenge_id,
        signature: key.sign(
          registrationPayload({
            workspaceId: "ws_1",
            hostId: "host_1",
            challengeId: challenge.challenge_id,
            nonce: challenge.nonce,
          }),
        ),
        ttl_ms: 90_000,
      } as never),
    ).resolves.toEqual({
      host_id: "host_1",
      workspace_id: "ws_1",
      home_region: "eu-west",
      expires_at: 213_456,
      paused: false,
    })
    await t.run(async (ctx) => {
      const link = (await ctx.db.query("local_host_links").collect())[0]
      expect(link).toMatchObject({ host_id: "host_1", public_key: key.publicKey, expires_at: 213_456 })
    })

    await expect(
      owner.mutation(api.localHostLinks.heartbeat, {
        workspace_id: "ws_1",
        host_id: "host_1",
        signature: key.sign(heartbeatPayload({ workspaceId: "ws_1", hostId: "host_1", ttlMs: 60_000 })),
        ttl_ms: 60_000,
      } as never),
    ).resolves.toEqual({
      host_id: "host_1",
      workspace_id: "ws_1",
      home_region: "eu-west",
      expires_at: 183_456,
      paused: false,
    })
  })

  test("heartbeat tolerates the same host_id registered for another workspace (no .unique() crash)", async () => {
    vi.spyOn(Date, "now").mockReturnValue(123_456)
    const key = hostKey()
    const t = convexTest(schema, modules)
    // The SAME host_id is linked to two different workspaces — what happens
    // when a CLI re-runs `claxedo up` across workspaces. The old heartbeat
    // used by_host_id.unique() and 500'd here.
    const { linkTargetId, linkOtherId } = await t.run(async (ctx) => {
      const ownerId = await ctx.db.insert("users", stamped({ token_identifier: "owner_token" }) as never)
      const ws1Id = await ctx.db.insert(
        "workspaces",
        stamped({
          workspace_id: "ws_1",
          owner_user_id: ownerId,
          backing: "local-worktree",
          access: "user-hosted",
          display_name: "WS1",
          home_region: "eu-west",
        }) as never,
      )
      const ws2Id = await ctx.db.insert(
        "workspaces",
        stamped({
          workspace_id: "ws_2",
          owner_user_id: ownerId,
          backing: "local-worktree",
          access: "user-hosted",
          display_name: "WS2",
          home_region: "eu-west",
        }) as never,
      )
      const linkOtherId = await ctx.db.insert(
        "local_host_links",
        stamped({
          workspace_id: ws2Id,
          owner_user_id: ownerId,
          host_id: "host_1",
          public_key: key.publicKey,
          expires_at: 999_999,
          last_seen_at: 100,
        }) as never,
      )
      const linkTargetId = await ctx.db.insert(
        "local_host_links",
        stamped({
          workspace_id: ws1Id,
          owner_user_id: ownerId,
          host_id: "host_1",
          public_key: key.publicKey,
          expires_at: 999_999,
          last_seen_at: 100,
        }) as never,
      )
      return { linkTargetId, linkOtherId }
    })
    const owner = asOwner(t)

    await expect(
      owner.mutation(api.localHostLinks.heartbeat, {
        workspace_id: "ws_1",
        host_id: "host_1",
        signature: key.sign(heartbeatPayload({ workspaceId: "ws_1", hostId: "host_1", ttlMs: 60_000 })),
        ttl_ms: 60_000,
      } as never),
    ).resolves.toMatchObject({ host_id: "host_1", workspace_id: "ws_1", paused: false })
    // It refreshed THIS workspace's link, not the other workspace's.
    await t.run(async (ctx) => {
      expect(await ctx.db.get(linkTargetId)).toMatchObject({ last_seen_at: 123_456 })
      expect(await ctx.db.get(linkOtherId)).toMatchObject({ last_seen_at: 100 })
    })
  })

  test("rejects Local Host Link registration signed by the wrong host key", async () => {
    const key = hostKey()
    const otherKey = hostKey()
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const ownerId = await ctx.db.insert("users", stamped({ token_identifier: "owner_token" }) as never)
      await ctx.db.insert(
        "workspaces",
        stamped({
          workspace_id: "ws_1",
          owner_user_id: ownerId,
          backing: "local-worktree",
          access: "user-hosted",
          display_name: "Workspace 1",
        }) as never,
      )
    })
    const owner = asOwner(t)
    const challenge = (await owner.mutation(api.localHostLinks.createChallenge, {
      workspace_id: "ws_1",
      host_id: "host_1",
    } as never)) as { challenge_id: string; nonce: string }

    await expect(
      owner.mutation(api.localHostLinks.register, {
        workspace_id: "ws_1",
        host_id: "host_1",
        public_key: key.publicKey,
        challenge_id: challenge.challenge_id,
        signature: otherKey.sign(
          registrationPayload({
            workspaceId: "ws_1",
            hostId: "host_1",
            challengeId: challenge.challenge_id,
            nonce: challenge.nonce,
          }),
        ),
      } as never),
    ).rejects.toThrow("Invalid host attestation")
  })

  test("a per-workspace pause is recorded as a USER pause", async () => {
    vi.spyOn(Date, "now").mockReturnValue(400_000)
    const t = convexTest(schema, modules)
    const linkId = await t.run(async (ctx) => {
      const ownerId = await ctx.db.insert("users", stamped({ token_identifier: "owner_token" }) as never)
      const workspaceId = await ctx.db.insert(
        "workspaces",
        stamped({
          workspace_id: "ws_1",
          owner_user_id: ownerId,
          backing: "local-worktree",
          access: "user-hosted",
          display_name: "Workspace 1",
        }) as never,
      )
      return ctx.db.insert(
        "local_host_links",
        stamped({
          owner_user_id: ownerId,
          workspace_id: workspaceId,
          host_id: "host_1",
          last_seen_at: 1,
          expires_at: 999_999,
        }) as never,
      )
    })
    const owner = asOwner(t)

    await owner.mutation(api.localHostLinks.pause, { workspace_id: "ws_1", host_id: "host_1", paused: true } as never)

    await t.run(async (ctx) => {
      expect(await ctx.db.get(linkId)).toMatchObject({
        paused_at: 400_000,
        paused_by: "user",
        paused_reason: "user_paused",
      })
    })
  })

  test("activeForRelay requires the control-plane service token and resolves the live link without user identity", async () => {
    vi.spyOn(Date, "now").mockReturnValue(123_456)
    const previous = process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
    process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = "relay-service-token"
    try {
      const t = convexTest(schema, modules)
      await t.run(async (ctx) => {
        const ownerId = await ctx.db.insert("users", stamped({ token_identifier: "owner_token" }) as never)
        const workspaceId = await ctx.db.insert(
          "workspaces",
          stamped({
            workspace_id: "ws_1",
            owner_user_id: ownerId,
            backing: "local-worktree",
            access: "local",
            display_name: "Workspace 1",
          }) as never,
        )
        await ctx.db.insert(
          "local_host_links",
          stamped({
            workspace_id: workspaceId,
            owner_user_id: ownerId,
            host_id: "host_1",
            expires_at: 999_999,
            last_seen_at: 100,
          }) as never,
        )
      })

      // No `.withIdentity()` at all — the relay resolver has no end-user identity.
      await expect(
        t.query(api.localHostLinks.activeForRelay, {
          service_token: "wrong-token",
          workspace_id: "ws_1",
        } as never),
      ).rejects.toThrow("Unauthenticated")

      await expect(
        t.query(api.localHostLinks.activeForRelay, {
          service_token: "relay-service-token",
          workspace_id: "ws_1",
        } as never),
      ).resolves.toMatchObject({ active: true, host_id: "host_1", backing: "local-worktree" })

      await expect(
        t.query(api.localHostLinks.activeForRelay, {
          service_token: "relay-service-token",
          workspace_id: "ws_unknown",
        } as never),
      ).resolves.toEqual({ active: false })

      // Fail closed when the deployment has no service token configured.
      delete process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
      await expect(
        t.query(api.localHostLinks.activeForRelay, {
          service_token: "relay-service-token",
          workspace_id: "ws_1",
        } as never),
      ).rejects.toThrow("Unauthenticated")
    } finally {
      if (previous === undefined) delete process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
      else process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = previous
    }
  })

  test("returns the workspace home_region as stored — no hardcoded fallback region", async () => {
    vi.spyOn(Date, "now").mockReturnValue(123_456)
    const key = hostKey()
    const t = convexTest(schema, modules)
    // Workspace has NO home_region: the result must not invent one — the
    // server normalizes with its configured default at read time.
    await t.run(async (ctx) => {
      const ownerId = await ctx.db.insert("users", stamped({ token_identifier: "owner_token" }) as never)
      await ctx.db.insert(
        "workspaces",
        stamped({
          workspace_id: "ws_1",
          owner_user_id: ownerId,
          backing: "local-worktree",
          access: "user-hosted",
          display_name: "Workspace 1",
        }) as never,
      )
    })
    const owner = asOwner(t)
    const challenge = (await owner.mutation(api.localHostLinks.createChallenge, {
      workspace_id: "ws_1",
      host_id: "host_1",
    } as never)) as { challenge_id: string; nonce: string }

    const result = (await owner.mutation(api.localHostLinks.register, {
      workspace_id: "ws_1",
      host_id: "host_1",
      public_key: key.publicKey,
      challenge_id: challenge.challenge_id,
      signature: key.sign(
        registrationPayload({
          workspaceId: "ws_1",
          hostId: "host_1",
          challengeId: challenge.challenge_id,
          nonce: challenge.nonce,
        }),
      ),
    } as never)) as { home_region?: string }
    expect(result.home_region).toBeUndefined()
  })

  test("cold hosted path: challenge → signed register creates the workspace doc owned by the proving caller", async () => {
    vi.spyOn(Date, "now").mockReturnValue(500_000)
    const key = hostKey()
    const forgedKey = hostKey()
    const t = convexTest(schema, modules)
    // The hosted first-time flow: NO workspace doc exists yet — the security
    // reorder runs registerLocalForSharing only AFTER host proof, so the
    // challenge/register pair must work without one.
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", stamped({ token_identifier: "owner_token" }) as never))
    const owner = asOwner(t)

    // Challenge: succeeds with no doc and mutates nothing but the nonce row.
    const challenge = (await owner.mutation(api.localHostLinks.createChallenge, {
      workspace_id: "ws_cold",
      host_id: "host_1",
    } as never)) as { challenge_id: string; nonce: string }
    await t.run(async (ctx) => {
      expect(await ctx.db.query("workspaces").collect()).toHaveLength(0)
      expect(await ctx.db.query("host_attestation_challenges").collect()).toHaveLength(1)
    })

    // A forged signature still creates NOTHING — workspace creation happens
    // strictly after host proof.
    await expect(
      owner.mutation(api.localHostLinks.register, {
        workspace_id: "ws_cold",
        host_id: "host_1",
        public_key: key.publicKey,
        challenge_id: challenge.challenge_id,
        signature: forgedKey.sign(
          registrationPayload({
            workspaceId: "ws_cold",
            hostId: "host_1",
            challengeId: challenge.challenge_id,
            nonce: challenge.nonce,
          }),
        ),
      } as never),
    ).rejects.toThrow("Invalid host attestation")
    await t.run(async (ctx) => {
      expect(await ctx.db.query("workspaces").collect()).toHaveLength(0)
      expect(await ctx.db.query("local_host_links").collect()).toHaveLength(0)
    })

    // Valid signature: the workspace doc is created with user-hosted backing,
    // owned by the calling user (mirrors registerLocalForSharing's insert).
    const result = (await owner.mutation(api.localHostLinks.register, {
      workspace_id: "ws_cold",
      host_id: "host_1",
      public_key: key.publicKey,
      challenge_id: challenge.challenge_id,
      signature: key.sign(
        registrationPayload({
          workspaceId: "ws_cold",
          hostId: "host_1",
          challengeId: challenge.challenge_id,
          nonce: challenge.nonce,
        }),
      ),
      display_name: "demo",
      ttl_ms: 90_000,
    } as never)) as { home_region?: string }
    expect(result).toMatchObject({
      host_id: "host_1",
      workspace_id: "ws_cold",
      expires_at: 590_000,
      paused: false,
    })
    expect(result.home_region).toBeUndefined()

    const workspaceDocId = await t.run(async (ctx) => {
      const rows = await ctx.db.query("workspaces").collect()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        workspace_id: "ws_cold",
        owner_user_id: ownerId,
        backing: "local-worktree",
        access: "user-hosted",
        display_name: "demo",
      })
      const memberships = await ctx.db.query("workspace_memberships").collect()
      expect(memberships[0]).toMatchObject({ workspace_id: rows[0]!._id, user_id: ownerId, role: "owner" })
      const links = await ctx.db.query("local_host_links").collect()
      expect(links[0]).toMatchObject({
        workspace_id: rows[0]!._id,
        owner_user_id: ownerId,
        host_id: "host_1",
        public_key: key.publicKey,
      })
      return rows[0]!._id
    })

    // The route's subsequent registerLocalForSharing call patches the SAME
    // doc — no conflict, no duplicate, and its cloud-backing guard stays calm.
    const shared = (await owner.mutation(api.workspaces.registerLocalForSharing, {
      workspace_id: "ws_cold",
      display_name: "demo repo",
      home_region: "eu-west",
      repo_name: "demo",
    } as never)) as { workspace_doc_id: string; home_region?: string }
    expect(shared.workspace_doc_id).toBe(workspaceDocId)
    expect(shared.home_region).toBe("eu-west")
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("workspaces").collect()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        backing: "local-worktree",
        access: "user-hosted",
        display_name: "demo repo",
        home_region: "eu-west",
        repo_name: "demo",
      })
    })

    // Re-register (fresh challenge) keeps working against the now-existing doc
    // and patches the existing link instead of inserting a second one.
    const challenge2 = (await owner.mutation(api.localHostLinks.createChallenge, {
      workspace_id: "ws_cold",
      host_id: "host_1",
    } as never)) as { challenge_id: string; nonce: string }
    await expect(
      owner.mutation(api.localHostLinks.register, {
        workspace_id: "ws_cold",
        host_id: "host_1",
        public_key: key.publicKey,
        challenge_id: challenge2.challenge_id,
        signature: key.sign(
          registrationPayload({
            workspaceId: "ws_cold",
            hostId: "host_1",
            challengeId: challenge2.challenge_id,
            nonce: challenge2.nonce,
          }),
        ),
      } as never),
    ).resolves.toMatchObject({
      host_id: "host_1",
      workspace_id: "ws_cold",
      home_region: "eu-west",
      paused: false,
    })
    await t.run(async (ctx) => {
      expect(await ctx.db.query("local_host_links").collect()).toHaveLength(1)
      expect(await ctx.db.query("workspaces").collect()).toHaveLength(1)
    })
  })

  test("a cold challenge cannot register over a workspace that became cloud-backed in the meantime", async () => {
    vi.spyOn(Date, "now").mockReturnValue(700_000)
    const key = hostKey()
    const t = convexTest(schema, modules)
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", stamped({ token_identifier: "owner_token" }) as never))
    const owner = asOwner(t)
    const challenge = (await owner.mutation(api.localHostLinks.createChallenge, {
      workspace_id: "ws_race",
      host_id: "host_1",
    } as never)) as { challenge_id: string; nonce: string }

    // The workspace gets created as cloud-backed between challenge and register.
    await t.run(async (ctx) =>
      ctx.db.insert(
        "workspaces",
        stamped({
          workspace_id: "ws_race",
          owner_user_id: ownerId,
          backing: "cloud-vm",
          access: "cloud",
          display_name: "raced cloud workspace",
        }) as never,
      ),
    )

    await expect(
      owner.mutation(api.localHostLinks.register, {
        workspace_id: "ws_race",
        host_id: "host_1",
        public_key: key.publicKey,
        challenge_id: challenge.challenge_id,
        signature: key.sign(
          registrationPayload({
            workspaceId: "ws_race",
            hostId: "host_1",
            challengeId: challenge.challenge_id,
            nonce: challenge.nonce,
          }),
        ),
      } as never),
    ).rejects.toThrow("workspace_backing_conflict")
    await t.run(async (ctx) => {
      expect(await ctx.db.query("local_host_links").collect()).toHaveLength(0)
    })
  })

  test("refuses challenges and registrations against cloud-backed workspaces", async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const ownerId = await ctx.db.insert("users", stamped({ token_identifier: "owner_token" }) as never)
      await ctx.db.insert(
        "workspaces",
        stamped({
          workspace_id: "ws_1",
          owner_user_id: ownerId,
          backing: "cloud-vm",
          access: "cloud",
          display_name: "cloud workspace",
        }) as never,
      )
    })
    const owner = asOwner(t)

    await expect(
      owner.mutation(api.localHostLinks.createChallenge, {
        workspace_id: "ws_1",
        host_id: "host_1",
      } as never),
    ).rejects.toThrow("workspace_backing_conflict")
    await t.run(async (ctx) => {
      expect(await ctx.db.query("host_attestation_challenges").collect()).toHaveLength(0)
    })
  })
})
