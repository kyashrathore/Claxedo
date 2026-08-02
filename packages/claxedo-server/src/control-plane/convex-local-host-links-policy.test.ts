import { afterEach, describe, expect, test, vi } from "vitest"
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto"
import { activeForRelay, createChallenge, heartbeat, pause, register } from "../../../../convex/localHostLinks"
import { registerLocalForSharing } from "../../../../convex/workspaces"

type Row = Record<string, unknown> & { _id: string }

function db(seed: Record<string, Row[]>) {
  const rows = Object.fromEntries(Object.entries(seed).map(([key, value]) => [key, [...value]]))
  return {
    rows,
    query(table: string) {
      const filters: Array<[string, unknown]> = []
      const query = {
        withIndex(_name: string, build: (q: { eq: (key: string, value: unknown) => unknown }) => unknown) {
          build({
            eq(key, value) {
              filters.push([key, value])
              return this
            },
          })
          return query
        },
        async collect() {
          return (rows[table] ?? []).filter((row) => filters.every(([key, value]) => row[key] === value))
        },
        async unique() {
          return (await query.collect())[0]
        },
      }
      return query
    },
    async insert(table: string, row: Record<string, unknown>) {
      const id = `${table}:${(rows[table] ?? []).length + 1}`
      rows[table] ??= []
      rows[table].push({ _id: id, ...row })
      return id
    },
    async get(id: string) {
      return Object.values(rows).flat().find((row) => row._id === id) ?? null
    },
    async patch(id: string, patch: Record<string, unknown>) {
      for (const table of Object.keys(rows)) {
        const index = rows[table]!.findIndex((row) => row._id === id)
        if (index === -1) continue
        rows[table]![index] = { ...rows[table]![index], ...patch }
        return
      }
      throw new Error(`Missing row ${id}`)
    },
  }
}

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

function registrationPayload(input: {
  workspaceId: string
  hostId: string
  challengeId: string
  nonce: string
}) {
  return [
    "claxedo.local-host-link.register.v1",
    `workspace_id=${input.workspaceId}`,
    `host_id=${input.hostId}`,
    `challenge_id=${input.challengeId}`,
    `nonce=${input.nonce}`,
  ].join("\n")
}

function heartbeatPayload(input: {
  workspaceId: string
  hostId: string
  ttlMs?: number
}) {
  return [
    "claxedo.local-host-link.heartbeat.v1",
    `workspace_id=${input.workspaceId}`,
    `host_id=${input.hostId}`,
    `ttl_ms=${input.ttlMs ?? ""}`,
  ].join("\n")
}

function handler(fn: unknown) {
  return (fn as { _handler: (ctx: unknown, args: Record<string, unknown>) => Promise<unknown> })._handler
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("Convex Local Host Link pause policy", () => {
  test("requires host key attestation for register and heartbeat", async () => {
    vi.spyOn(Date, "now").mockReturnValue(123_456)
    const key = hostKey()
    const store = db({
      users: [{ _id: "user_owner", token_identifier: "owner_token" }],
      workspaces: [{ _id: "workspace_1", workspace_id: "ws_1", owner_user_id: "user_owner", home_region: "eu-west" }],
      workspace_memberships: [],
      workspace_share_grants: [],
      org_memberships: [],
      local_host_links: [],
      host_attestation_challenges: [],
    })
    const ctx = {
      db: store,
      auth: {
        getUserIdentity: async () => ({
          tokenIdentifier: "owner_token",
        }),
      },
    }

    const challenge = await handler(createChallenge)(ctx, {
      workspace_id: "ws_1",
      host_id: "host_1",
    }) as { challenge_id: string; nonce: string; expires_at: number }

    await expect(handler(register)(ctx, {
      workspace_id: "ws_1",
      host_id: "host_1",
      public_key: key.publicKey,
      challenge_id: challenge.challenge_id,
      signature: key.sign(registrationPayload({
        workspaceId: "ws_1",
        hostId: "host_1",
        challengeId: challenge.challenge_id,
        nonce: challenge.nonce,
      })),
      ttl_ms: 90_000,
    })).resolves.toEqual({
      host_id: "host_1",
      workspace_id: "ws_1",
      home_region: "eu-west",
      expires_at: 213_456,
      paused: false,
    })
    expect(store.rows.local_host_links[0]).toMatchObject({
      host_id: "host_1",
      public_key: key.publicKey,
      expires_at: 213_456,
    })

    await expect(handler(heartbeat)(ctx, {
      workspace_id: "ws_1",
      host_id: "host_1",
      signature: key.sign(heartbeatPayload({
        workspaceId: "ws_1",
        hostId: "host_1",
        ttlMs: 60_000,
      })),
      ttl_ms: 60_000,
    })).resolves.toEqual({
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
    const store = db({
      users: [{ _id: "user_owner", token_identifier: "owner_token" }],
      workspaces: [
        { _id: "workspace_1", workspace_id: "ws_1", owner_user_id: "user_owner", home_region: "eu-west" },
        { _id: "workspace_2", workspace_id: "ws_2", owner_user_id: "user_owner", home_region: "eu-west" },
      ],
      workspace_memberships: [],
      workspace_share_grants: [],
      org_memberships: [],
      // The SAME host_id is linked to two different workspaces — what happens
      // when a CLI re-runs `claxedo up` across workspaces. The old heartbeat
      // used by_host_id.unique() and 500'd here.
      local_host_links: [
        { _id: "link_other", workspace_id: "workspace_2", host_id: "host_1", public_key: key.publicKey, expires_at: 999_999, last_seen_at: 100, created_at: 1, updated_at: 1 },
        { _id: "link_target", workspace_id: "workspace_1", host_id: "host_1", public_key: key.publicKey, expires_at: 999_999, last_seen_at: 100, created_at: 1, updated_at: 1 },
      ],
      host_attestation_challenges: [],
    })
    const ctx = { db: store, auth: { getUserIdentity: async () => ({ tokenIdentifier: "owner_token" }) } }

    await expect(handler(heartbeat)(ctx, {
      workspace_id: "ws_1",
      host_id: "host_1",
      signature: key.sign(heartbeatPayload({ workspaceId: "ws_1", hostId: "host_1", ttlMs: 60_000 })),
      ttl_ms: 60_000,
    })).resolves.toMatchObject({ host_id: "host_1", workspace_id: "ws_1", paused: false })
    // It refreshed THIS workspace's link, not the other workspace's.
    expect(store.rows.local_host_links.find((l: { _id: string }) => l._id === "link_target")).toMatchObject({ last_seen_at: 123_456 })
    expect(store.rows.local_host_links.find((l: { _id: string }) => l._id === "link_other")).toMatchObject({ last_seen_at: 100 })
  })

  test("rejects Local Host Link registration signed by the wrong host key", async () => {
    const key = hostKey()
    const otherKey = hostKey()
    const store = db({
      users: [{ _id: "user_owner", token_identifier: "owner_token" }],
      workspaces: [{ _id: "workspace_1", workspace_id: "ws_1", owner_user_id: "user_owner" }],
      workspace_memberships: [],
      workspace_share_grants: [],
      org_memberships: [],
      local_host_links: [],
      host_attestation_challenges: [],
    })
    const ctx = {
      db: store,
      auth: {
        getUserIdentity: async () => ({
          tokenIdentifier: "owner_token",
        }),
      },
    }
    const challenge = await handler(createChallenge)(ctx, {
      workspace_id: "ws_1",
      host_id: "host_1",
    }) as { challenge_id: string; nonce: string }

    await expect(handler(register)(ctx, {
      workspace_id: "ws_1",
      host_id: "host_1",
      public_key: key.publicKey,
      challenge_id: challenge.challenge_id,
      signature: otherKey.sign(registrationPayload({
        workspaceId: "ws_1",
        hostId: "host_1",
        challengeId: challenge.challenge_id,
        nonce: challenge.nonce,
      })),
    })).rejects.toThrow("Invalid host attestation")
  })

  test("a per-workspace pause is recorded as a USER pause", async () => {
    vi.spyOn(Date, "now").mockReturnValue(400_000)
    const store = db({
      users: [{ _id: "user_owner", token_identifier: "owner_token" }],
      workspaces: [{ _id: "workspace_1", workspace_id: "ws_1", owner_user_id: "user_owner" }],
      workspace_memberships: [],
      workspace_share_grants: [],
      org_memberships: [],
      local_host_links: [
        { _id: "link_1", owner_user_id: "user_owner", workspace_id: "workspace_1", host_id: "host_1" },
      ],
    })
    const ctx = {
      db: store,
      auth: { getUserIdentity: async () => ({ tokenIdentifier: "owner_token" }) },
    }

    await handler(pause)(ctx, { workspace_id: "ws_1", host_id: "host_1", paused: true })
    expect(store.rows.local_host_links[0]).toMatchObject({
      paused_at: 400_000,
      paused_by: "user",
      paused_reason: "user_paused",
    })
  })

  test("activeForRelay requires the control-plane service token and resolves the live link without user identity", async () => {
    vi.spyOn(Date, "now").mockReturnValue(123_456)
    const previous = process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
    process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = "relay-service-token"
    try {
      const store = db({
        users: [{ _id: "user_owner", token_identifier: "owner_token" }],
        workspaces: [{ _id: "workspace_1", workspace_id: "ws_1", owner_user_id: "user_owner", backing: "local-worktree" }],
        workspace_memberships: [],
        workspace_share_grants: [],
        org_memberships: [],
        local_host_links: [
          { _id: "link_1", workspace_id: "workspace_1", host_id: "host_1", expires_at: 999_999, last_seen_at: 100 },
        ],
        host_attestation_challenges: [],
      })
      // No ctx.auth at all — the relay resolver has no end-user identity.
      const ctx = { db: store, auth: { getUserIdentity: async () => null } }

      await expect(handler(activeForRelay)(ctx, {
        service_token: "wrong-token",
        workspace_id: "ws_1",
      })).rejects.toThrow("Unauthenticated")

      await expect(handler(activeForRelay)(ctx, {
        service_token: "relay-service-token",
        workspace_id: "ws_1",
      })).resolves.toMatchObject({ active: true, host_id: "host_1", backing: "local-worktree" })

      await expect(handler(activeForRelay)(ctx, {
        service_token: "relay-service-token",
        workspace_id: "ws_unknown",
      })).resolves.toEqual({ active: false })

      // Fail closed when the deployment has no service token configured.
      delete process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
      await expect(handler(activeForRelay)(ctx, {
        service_token: "relay-service-token",
        workspace_id: "ws_1",
      })).rejects.toThrow("Unauthenticated")
    } finally {
      if (previous === undefined) delete process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
      else process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = previous
    }
  })

  test("returns the workspace home_region as stored — no hardcoded fallback region", async () => {
    vi.spyOn(Date, "now").mockReturnValue(123_456)
    const key = hostKey()
    const store = db({
      users: [{ _id: "user_owner", token_identifier: "owner_token" }],
      // Workspace has NO home_region: the result must not invent one — the
      // server normalizes with its configured default at read time.
      workspaces: [{ _id: "workspace_1", workspace_id: "ws_1", owner_user_id: "user_owner" }],
      workspace_memberships: [],
      workspace_share_grants: [],
      org_memberships: [],
      local_host_links: [],
      host_attestation_challenges: [],
    })
    const ctx = {
      db: store,
      auth: { getUserIdentity: async () => ({ tokenIdentifier: "owner_token" }) },
    }

    const challenge = await handler(createChallenge)(ctx, {
      workspace_id: "ws_1",
      host_id: "host_1",
    }) as { challenge_id: string; nonce: string }

    const result = await handler(register)(ctx, {
      workspace_id: "ws_1",
      host_id: "host_1",
      public_key: key.publicKey,
      challenge_id: challenge.challenge_id,
      signature: key.sign(registrationPayload({
        workspaceId: "ws_1",
        hostId: "host_1",
        challengeId: challenge.challenge_id,
        nonce: challenge.nonce,
      })),
    }) as { home_region?: string }
    expect(result.home_region).toBeUndefined()
  })

  test("cold hosted path: challenge → signed register creates the workspace doc owned by the proving caller", async () => {
    vi.spyOn(Date, "now").mockReturnValue(500_000)
    const key = hostKey()
    const forgedKey = hostKey()
    const store = db({
      users: [{ _id: "user_owner", token_identifier: "owner_token" }],
      // The hosted first-time flow: NO workspace doc exists yet — the security
      // reorder runs registerLocalForSharing only AFTER host proof, so the
      // challenge/register pair must work without one.
      workspaces: [],
      workspace_memberships: [],
      workspace_share_grants: [],
      org_memberships: [],
      local_host_links: [],
      host_attestation_challenges: [],
    })
    const ctx = {
      db: store,
      auth: { getUserIdentity: async () => ({ tokenIdentifier: "owner_token" }) },
    }

    // Challenge: succeeds with no doc and mutates nothing but the nonce row.
    const challenge = await handler(createChallenge)(ctx, {
      workspace_id: "ws_cold",
      host_id: "host_1",
    }) as { challenge_id: string; nonce: string }
    expect(store.rows.workspaces).toHaveLength(0)
    expect(store.rows.host_attestation_challenges).toHaveLength(1)

    // A forged signature still creates NOTHING — workspace creation happens
    // strictly after host proof.
    await expect(handler(register)(ctx, {
      workspace_id: "ws_cold",
      host_id: "host_1",
      public_key: key.publicKey,
      challenge_id: challenge.challenge_id,
      signature: forgedKey.sign(registrationPayload({
        workspaceId: "ws_cold",
        hostId: "host_1",
        challengeId: challenge.challenge_id,
        nonce: challenge.nonce,
      })),
    })).rejects.toThrow("Invalid host attestation")
    expect(store.rows.workspaces).toHaveLength(0)
    expect(store.rows.local_host_links).toHaveLength(0)

    // Valid signature: the workspace doc is created with user-hosted backing,
    // owned by the calling user (mirrors registerLocalForSharing's insert).
    const result = await handler(register)(ctx, {
      workspace_id: "ws_cold",
      host_id: "host_1",
      public_key: key.publicKey,
      challenge_id: challenge.challenge_id,
      signature: key.sign(registrationPayload({
        workspaceId: "ws_cold",
        hostId: "host_1",
        challengeId: challenge.challenge_id,
        nonce: challenge.nonce,
      })),
      display_name: "demo",
      ttl_ms: 90_000,
    }) as { home_region?: string }
    expect(result).toMatchObject({
      host_id: "host_1",
      workspace_id: "ws_cold",
      expires_at: 590_000,
      paused: false,
    })
    expect(result.home_region).toBeUndefined()
    expect(store.rows.workspaces).toHaveLength(1)
    expect(store.rows.workspaces[0]).toMatchObject({
      workspace_id: "ws_cold",
      owner_user_id: "user_owner",
      backing: "local-worktree",
      access: "user-hosted",
      display_name: "demo",
    })
    expect(store.rows.workspace_memberships[0]).toMatchObject({
      workspace_id: store.rows.workspaces[0]!._id,
      user_id: "user_owner",
      role: "owner",
    })
    expect(store.rows.local_host_links[0]).toMatchObject({
      workspace_id: store.rows.workspaces[0]!._id,
      owner_user_id: "user_owner",
      host_id: "host_1",
      public_key: key.publicKey,
    })

    // The route's subsequent registerLocalForSharing call patches the SAME
    // doc — no conflict, no duplicate, and its cloud-backing guard stays calm.
    const shared = await handler(registerLocalForSharing)(ctx, {
      workspace_id: "ws_cold",
      display_name: "demo repo",
      home_region: "eu-west",
      repo_name: "demo",
    }) as { workspace_doc_id: string; home_region?: string }
    expect(shared.workspace_doc_id).toBe(store.rows.workspaces[0]!._id)
    expect(shared.home_region).toBe("eu-west")
    expect(store.rows.workspaces).toHaveLength(1)
    expect(store.rows.workspaces[0]).toMatchObject({
      backing: "local-worktree",
      access: "user-hosted",
      display_name: "demo repo",
      home_region: "eu-west",
      repo_name: "demo",
    })

    // Re-register (fresh challenge) keeps working against the now-existing doc
    // and patches the existing link instead of inserting a second one.
    const challenge2 = await handler(createChallenge)(ctx, {
      workspace_id: "ws_cold",
      host_id: "host_1",
    }) as { challenge_id: string; nonce: string }
    await expect(handler(register)(ctx, {
      workspace_id: "ws_cold",
      host_id: "host_1",
      public_key: key.publicKey,
      challenge_id: challenge2.challenge_id,
      signature: key.sign(registrationPayload({
        workspaceId: "ws_cold",
        hostId: "host_1",
        challengeId: challenge2.challenge_id,
        nonce: challenge2.nonce,
      })),
    })).resolves.toMatchObject({
      host_id: "host_1",
      workspace_id: "ws_cold",
      home_region: "eu-west",
      paused: false,
    })
    expect(store.rows.local_host_links).toHaveLength(1)
    expect(store.rows.workspaces).toHaveLength(1)
  })

  test("a cold challenge cannot register over a workspace that became cloud-backed in the meantime", async () => {
    vi.spyOn(Date, "now").mockReturnValue(700_000)
    const key = hostKey()
    const store = db({
      users: [{ _id: "user_owner", token_identifier: "owner_token" }],
      workspaces: [],
      workspace_memberships: [],
      workspace_share_grants: [],
      org_memberships: [],
      local_host_links: [],
      host_attestation_challenges: [],
    })
    const ctx = {
      db: store,
      auth: { getUserIdentity: async () => ({ tokenIdentifier: "owner_token" }) },
    }
    const challenge = await handler(createChallenge)(ctx, {
      workspace_id: "ws_race",
      host_id: "host_1",
    }) as { challenge_id: string; nonce: string }

    // The workspace gets created as cloud-backed between challenge and register.
    store.rows.workspaces.push({
      _id: "workspace_cloud",
      workspace_id: "ws_race",
      owner_user_id: "user_owner",
      backing: "cloud-vm",
      access: "cloud",
    })

    await expect(handler(register)(ctx, {
      workspace_id: "ws_race",
      host_id: "host_1",
      public_key: key.publicKey,
      challenge_id: challenge.challenge_id,
      signature: key.sign(registrationPayload({
        workspaceId: "ws_race",
        hostId: "host_1",
        challengeId: challenge.challenge_id,
        nonce: challenge.nonce,
      })),
    })).rejects.toThrow("workspace_backing_conflict")
    expect(store.rows.local_host_links).toHaveLength(0)
  })

  test("refuses challenges and registrations against cloud-backed workspaces", async () => {
    const store = db({
      users: [{ _id: "user_owner", token_identifier: "owner_token" }],
      workspaces: [{
        _id: "workspace_1",
        workspace_id: "ws_1",
        owner_user_id: "user_owner",
        backing: "cloud-vm",
        access: "cloud",
      }],
      workspace_memberships: [],
      workspace_share_grants: [],
      org_memberships: [],
      local_host_links: [],
      host_attestation_challenges: [],
    })
    const ctx = {
      db: store,
      auth: { getUserIdentity: async () => ({ tokenIdentifier: "owner_token" }) },
    }

    await expect(handler(createChallenge)(ctx, {
      workspace_id: "ws_1",
      host_id: "host_1",
    })).rejects.toThrow("workspace_backing_conflict")
    expect(store.rows.host_attestation_challenges).toHaveLength(0)
  })
})
