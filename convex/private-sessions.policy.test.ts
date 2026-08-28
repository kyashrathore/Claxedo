import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { convexTest } from "convex-test"
import { exercisePrivateSessionAuthorityConformance } from "../packages/claxedo-server-core/src/platform/auth/private-session-authority.conformance"
import type { SignedControlPlaneAuth } from "../packages/claxedo-server-core/src/platform/auth/auth"
import { createConvexAuthority } from "../packages/claxedo-server/src/authority/adapters/convex/workspace-authority"
import schema from "./schema"

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>
  }
}

const modules = import.meta.glob("./**/*.ts")
const previousServiceToken = process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
const serviceToken = "private-session-conformance-service-token"

const signed = (tokenIdentifier: string): SignedControlPlaneAuth => ({
  mode: "signed",
  token: tokenIdentifier,
  user: {
    subject: tokenIdentifier,
    tokenIdentifier,
    issuer: "https://identity.example.test",
  },
})

describe("Convex private-session authority", () => {
  beforeEach(() => {
    process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = serviceToken
  })

  afterEach(() => {
    if (previousServiceToken === undefined) delete process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
    else process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = previousServiceToken
  })

  test("passes the provider-neutral private-session conformance suite", async () => {
    const t = convexTest(schema, modules)
    const seeded = await t.run(async (ctx) => {
      const now = 1
      const orgId = await ctx.db.insert("orgs", { name: "Acme", created_at: now, updated_at: now } as never)
      const creatorId = await ctx.db.insert("users", {
        token_identifier: "creator-token",
        kind: "human",
        created_at: now,
        updated_at: now,
      } as never)
      const participantId = await ctx.db.insert("users", {
        token_identifier: "participant-token",
        kind: "human",
        created_at: now,
        updated_at: now,
      } as never)
      const adminId = await ctx.db.insert("users", {
        token_identifier: "admin-token",
        kind: "human",
        created_at: now,
        updated_at: now,
      } as never)
      const workspaceId = await ctx.db.insert("workspaces", {
        workspace_id: "ws_private_conformance",
        org_id: orgId,
        owner_user_id: creatorId,
        backing: "cloud-vm",
        access: "cloud",
        display_name: "Private sessions",
        created_at: now,
        updated_at: now,
      } as never)
      await ctx.db.insert("workspace_memberships", {
        workspace_id: workspaceId,
        user_id: participantId,
        role: "editor",
        created_at: now,
        updated_at: now,
      } as never)
      await ctx.db.insert("org_memberships", {
        org_id: orgId,
        user_id: adminId,
        role: "admin",
        created_at: now,
        updated_at: now,
      } as never)
      return { creatorId: String(creatorId), participantId: String(participantId) }
    })

    const identities = {
      "creator-token": t.withIdentity({ tokenIdentifier: "creator-token", subject: "creator-token" }),
      "participant-token": t.withIdentity({ tokenIdentifier: "participant-token", subject: "participant-token" }),
      "admin-token": t.withIdentity({ tokenIdentifier: "admin-token", subject: "admin-token" }),
    }
    const authority = createConvexAuthority({
      serviceToken,
      executorForAuth: (auth) => {
        const client: any = auth ? identities[auth.user.tokenIdentifier as keyof typeof identities] : t
        if (!client) throw new Error(`Unexpected conformance identity: ${auth?.user.tokenIdentifier}`)
        return {
          query: (fn, args) => client.query(fn, args),
          mutation: (fn, args) => client.mutation(fn, args),
        }
      },
    })

    await expect(exercisePrivateSessionAuthorityConformance({
      authority,
      workspaceId: "ws_private_conformance",
      creator: {
        auth: signed("creator-token"),
        runtime: { principalKind: "user", actorId: seeded.creatorId, actorKind: "human" },
      },
      participant: {
        auth: signed("participant-token"),
        runtime: { principalKind: "user", actorId: seeded.participantId, actorKind: "human" },
      },
    })).resolves.toMatchObject({
      lifecycle: { reserved: true, reconciled: true, compensated: true },
      access: { deniedBeforeGrant: true, allowedAfterGrant: true, deniedAfterRevoke: true },
      attribution: { canonicalActorPreserved: true, forgedActorRemoved: true },
    })
    await expect(authority.authorizeSessionWrite(signed("admin-token"), {
      sessionId: "ses_private_session_contract",
      workspaceId: "ws_private_conformance",
    })).resolves.toBeUndefined()
  })

  test("rejects changed reservation retries and visibility before registration", async () => {
    const t = convexTest(schema, modules)
    const creatorId = await t.run(async (ctx) => {
      const now = 1
      const orgId = await ctx.db.insert("orgs", { name: "Acme", created_at: now, updated_at: now } as never)
      const userId = await ctx.db.insert("users", {
        token_identifier: "creator-token",
        kind: "human",
        created_at: now,
        updated_at: now,
      } as never)
      await ctx.db.insert("workspaces", {
        workspace_id: "ws_private_negative",
        org_id: orgId,
        owner_user_id: userId,
        backing: "cloud-vm",
        access: "cloud",
        display_name: "Private sessions",
        created_at: now,
        updated_at: now,
      } as never)
      return String(userId)
    })
    const asCreator = t.withIdentity({ tokenIdentifier: "creator-token", subject: "creator-token" })
    const authority = createConvexAuthority({
      serviceToken,
      executorForAuth: (auth) => {
        const client: any = auth ? asCreator : t
        return {
          query: (fn, args) => client.query(fn, args),
          mutation: (fn, args) => client.mutation(fn, args),
        }
      },
    })
    const auth = signed("creator-token")
    await authority.reserveSession(auth, {
      operationId: "op_exact",
      sessionId: "ses_exact",
      workspaceId: "ws_private_negative",
      kind: "create",
    })
    await expect(authority.reserveSession(auth, {
      operationId: "op_exact",
      sessionId: "ses_changed",
      workspaceId: "ws_private_negative",
      kind: "create",
    })).rejects.toThrow("resource_conflict")
    await expect(authority.upsertSessionVisibility(auth, {
      workspaceId: "ws_private_negative",
      sessions: [{ sessionId: "ses_exact", title: "Too early" }],
    })).rejects.toThrow("workspace_authorization_denied")

    await expect(authority.registerRuntimeSession({
      principalKind: "user",
      actorId: creatorId,
      actorKind: "human",
      operationId: "op_exact",
      sessionId: "ses_wrong",
      workspaceId: "ws_private_negative",
    })).rejects.toThrow("resource_conflict")
  })
})
