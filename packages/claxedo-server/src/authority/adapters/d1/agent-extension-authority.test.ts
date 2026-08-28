import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test } from "vitest"
import { Miniflare } from "miniflare"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { AuthIdentity, ControlPlanePrincipal } from "@claxedo/server-core/platform/auth/authentication"

import { createD1CoreAuthority, type D1CoreAuthorityBoundary } from "./core-authority"
import { D1AgentExtensionAuthority } from "./agent-extension-authority"
import { D1AuditAuthority } from "./audit-authority"

const MIGRATIONS = [
  "0001_service_installations.sql",
  "0002_workspace_authority.sql",
  "0003_private_sessions.sql",
  "0004_host_access_and_sharing.sql",
  "0005_agent_extensions_and_audit.sql",
].map((name) => fileURLToPath(new URL(`../../../../migrations/control-plane/${name}`, import.meta.url)))

const active: Miniflare[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

async function setup() {
  const instance = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2025-05-01",
    d1Databases: ["CONTROL_PLANE_DB"],
  })
  active.push(instance)
  const database = await instance.getD1Database("CONTROL_PLANE_DB")
  for (const path of MIGRATIONS) {
    const migration = (await readFile(path, "utf8")).replace(/^\s*--.*$/gm, "")
    for (const statement of migration.split(/;\s*\n\s*\n/).map((part) => part.trim()).filter(Boolean)) {
      await database.prepare(statement).run()
    }
  }
  let clock = 1_800_000_000_000
  const authority = createD1CoreAuthority(database, {
    deploymentId: "deployment-a",
    product: { kind: "claxedo-hosted" },
    now: () => clock,
  })
  return { authority, database, setClock: (value: number) => { clock = value } }
}

async function signed(authority: D1CoreAuthorityBoundary, subject: string): Promise<SignedControlPlaneAuth> {
  const identity: AuthIdentity = { adapter: "better-auth", issuer: "https://auth.example.test", subject }
  const mapped = await authority.ensureApplicationIdentity(identity)
  if (mapped.state !== "active") throw new Error(`identity did not become active: ${mapped.state}`)
  const principal: ControlPlanePrincipal = {
    userId: mapped.userId,
    actorId: mapped.actorId,
    actorKind: "human",
    deploymentId: "deployment-a",
    sessionId: `session:${subject}`,
    authenticatedAt: 1_800_000_000_000,
    methods: ["oauth:github"],
    assurance: "single-factor",
    client: {
      kind: "browser",
      tokenKind: "browser-session",
      id: "browser",
      resource: "https://api.example.test",
      scopes: ["openid"],
      origin: "https://app.example.test",
    },
    identity,
  }
  return {
    mode: "signed",
    principal,
    user: {
      subject: mapped.userId,
      tokenIdentifier: `${identity.issuer}|${identity.subject}`,
      issuer: identity.issuer,
    },
  }
}

function desired(extensionId: string, packageName = extensionId, sourceOwner = "acme") {
  return {
    id: extensionId,
    package_name: packageName,
    source: { type: "github", owner: sourceOwner, repo: "extensions", ref: "main" },
    scope: "workspace",
    enabled: true,
    targets: ["opencode", "codex"],
    installed_at: 1_800_000_000_000,
    updated_at: 1_800_000_000_000,
  }
}

function lock(sourceOwner = "acme") {
  return {
    source: { type: "github", owner: sourceOwner, repo: "extensions", ref: "main" },
    resolved_sha: "0123456789abcdef",
    manifest_digests: { package: "manifest" },
    component_digests: { package: "component" },
    targets: ["opencode", "codex"],
  }
}

async function tenantFixture() {
  const fixture = await setup()
  const alice = await signed(fixture.authority, "alice")
  const bob = await signed(fixture.authority, "bob")
  const outsider = await signed(fixture.authority, "outsider")
  await fixture.authority.createHostedOrganization(alice, { name: "Acme", orgId: "org_acme" })
  await fixture.authority.addOrganizationMember(alice, {
    orgId: "org_acme",
    userId: bob.principal!.userId,
    role: "member",
  })
  await fixture.authority.createWorkspace(alice, {
    workspaceId: "ws_acme",
    orgId: "org_acme",
    displayName: "Acme workspace",
    backing: "cloud-vm",
    access: "cloud",
  })
  const grant = await fixture.authority.grantWorkspaceShare(alice, {
    workspaceId: "ws_acme",
    target: { kind: "actor", actorId: bob.principal!.actorId },
    role: "admin",
  }) as { grantId: string }
  return { ...fixture, alice, bob, outsider, grant }
}

describe("D1 Agent Extension authority", () => {
  test("persists canonical desired state with idempotent retry, enable, delete, and source-revival semantics", async () => {
    const { authority, database, alice, setClock } = await tenantFixture()
    const input = {
      workspaceId: "ws_acme",
      extensionId: "extension-a",
      packageName: "extension-a",
      desired: desired("extension-a"),
      lock: lock(),
    }
    await authority.upsertWorkspaceAgentExtension(alice, input)
    const first = await database.prepare(`
      select desired_json, lock_json, created_at, updated_at from agent_extension_installs
      where deployment_id = 'deployment-a' and workspace_id = 'ws_acme' and extension_id = 'extension-a'
    `).first<{ desired_json: string; lock_json: string; created_at: number; updated_at: number }>()
    expect(first?.desired_json).toBe(JSON.stringify({
      enabled: true,
      id: "extension-a",
      installed_at: 1_800_000_000_000,
      package_name: "extension-a",
      scope: "workspace",
      source: { owner: "acme", ref: "main", repo: "extensions", type: "github" },
      targets: ["opencode", "codex"],
      updated_at: 1_800_000_000_000,
    }))
    expect(first?.lock_json).toContain('"resolved_sha":"0123456789abcdef"')

    setClock(1_800_000_001_000)
    await authority.upsertWorkspaceAgentExtension(alice, input)
    const retry = await database.prepare(`
      select created_at, updated_at from agent_extension_installs
      where deployment_id = 'deployment-a' and workspace_id = 'ws_acme' and extension_id = 'extension-a'
    `).first<{ created_at: number; updated_at: number }>()
    expect(retry).toEqual({ created_at: first?.created_at, updated_at: first?.updated_at })

    await authority.setWorkspaceAgentExtensionEnabled(alice, {
      workspaceId: "ws_acme",
      extensionId: "extension-a",
      enabled: false,
    })
    await authority.setWorkspaceAgentExtensionEnabled(alice, {
      workspaceId: "ws_acme",
      extensionId: "extension-a",
      enabled: true,
    })
    await Promise.all([
      authority.setWorkspaceAgentExtensionEnabled(alice, {
        workspaceId: "ws_acme", extensionId: "extension-a", enabled: false,
      }),
      authority.setWorkspaceAgentExtensionEnabled(alice, {
        workspaceId: "ws_acme", extensionId: "extension-a", enabled: false,
      }),
    ])
    const revision = await database.prepare(`
      select revision from agent_extension_installs
      where deployment_id = 'deployment-a' and workspace_id = 'ws_acme' and extension_id = 'extension-a'
    `).first<{ revision: number }>()
    expect(revision?.revision).toBe(4)
    expect(await authority.listWorkspaceAgentExtensionsForRuntime({ workspaceId: "ws_acme" })).toEqual([
      expect.objectContaining({ desired: expect.objectContaining({ id: "extension-a", enabled: false }), enabled: false }),
    ])
    await authority.deleteWorkspaceAgentExtension(alice, { workspaceId: "ws_acme", extensionId: "extension-a" })
    await authority.deleteWorkspaceAgentExtension(alice, { workspaceId: "ws_acme", extensionId: "extension-a" })
    expect(await authority.listWorkspaceAgentExtensions(alice, { workspaceId: "ws_acme" })).toEqual([])

    await authority.upsertWorkspaceAgentExtension(alice, {
      ...input,
      desired: desired("extension-a", "extension-a", "new-owner"),
      lock: lock("new-owner"),
    })
    expect(await authority.listWorkspaceAgentExtensionsForRuntime({ workspaceId: "ws_acme" })).toEqual([
      expect.objectContaining({ desired: expect.objectContaining({ source: expect.objectContaining({ owner: "new-owner" }) }) }),
    ])
  })

  test("fails closed across tenant/deployment boundaries and makes a live source conflict atomic", async () => {
    const { authority, database, alice, bob, outsider, grant } = await tenantFixture()
    const input = {
      workspaceId: "ws_acme",
      extensionId: "extension-a",
      packageName: "extension-a",
      desired: desired("extension-a"),
      lock: lock(),
    }
    expect(await authority.listWorkspaceAgentExtensions(outsider, { workspaceId: "ws_acme" })).toEqual([])
    await expect(authority.upsertWorkspaceAgentExtension(outsider, input)).rejects.toMatchObject({ status: 403 })

    const results = await Promise.allSettled([
      authority.upsertWorkspaceAgentExtension(alice, input),
      authority.upsertWorkspaceAgentExtension(bob, {
        ...input,
        desired: desired("extension-a", "extension-a", "attacker"),
        lock: lock("attacker"),
      }),
    ])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
    const rows = await database.prepare(`select source_json from agent_extension_installs`).all<{ source_json: string }>()
    expect(rows.results).toHaveLength(1)

    const otherDeployment = new D1AgentExtensionAuthority(database, { deploymentId: "deployment-b" })
    expect(await otherDeployment.listWorkspaceAgentExtensionsForRuntime({ workspaceId: "ws_acme" })).toEqual([])

    await authority.revokeWorkspaceShare(alice, { workspaceId: "ws_acme", grantId: grant.grantId })
    await expect(authority.deleteWorkspaceAgentExtension(bob, {
      workspaceId: "ws_acme",
      extensionId: "extension-a",
    })).rejects.toMatchObject({ status: 403 })
  })

  test("enforces bounded canonical JSON and rejects cycles, mismatched identity, and oversized state", async () => {
    const { authority, alice } = await tenantFixture()
    const cyclic = desired("cyclic") as Record<string, unknown>
    cyclic.self = cyclic
    await expect(authority.upsertWorkspaceAgentExtension(alice, {
      workspaceId: "ws_acme",
      extensionId: "cyclic",
      packageName: "cyclic",
      desired: cyclic,
      lock: lock(),
    })).rejects.toMatchObject({ code: "invalid_input" })
    await expect(authority.upsertWorkspaceAgentExtension(alice, {
      workspaceId: "ws_acme",
      extensionId: "expected",
      packageName: "expected",
      desired: desired("different"),
      lock: lock(),
    })).rejects.toMatchObject({ code: "invalid_input" })
    await expect(authority.upsertWorkspaceAgentExtension(alice, {
      workspaceId: "ws_acme",
      extensionId: "large",
      packageName: "large",
      desired: { ...desired("large"), payload: "x".repeat(70_000) },
      lock: lock(),
    })).rejects.toMatchObject({ code: "invalid_input" })
  })

  test("applies org, user, and workspace policy precedence scopes without granting org authority to a workspace admin", async () => {
    const { authority, database, alice, bob } = await tenantFixture()
    await authority.setAgentExtensionPolicyOverride(alice, {
      workspaceId: "ws_acme",
      extensionId: "extension-a",
      scope: "org",
      enabled: false,
      reason: "organization disabled",
    })
    await authority.setAgentExtensionPolicyOverride(bob, {
      workspaceId: "ws_acme",
      extensionId: "extension-a",
      scope: "user",
      enabled: true,
    })
    await authority.setAgentExtensionPolicyOverride(bob, {
      workspaceId: "ws_acme",
      extensionId: "extension-a",
      scope: "workspace",
      enabled: true,
    })
    await expect(authority.setAgentExtensionPolicyOverride(bob, {
      workspaceId: "ws_acme",
      extensionId: "extension-b",
      scope: "org",
      enabled: true,
    })).rejects.toMatchObject({ status: 403 })

    expect(await authority.listAgentExtensionPolicyOverrides(bob, { workspaceId: "ws_acme" })).toEqual([
      { id: "extension-a", scope: "org", enabled: false, reason: "organization disabled" },
      { id: "extension-a", scope: "user", enabled: true },
      { id: "extension-a", scope: "workspace", enabled: true },
    ])
    expect(await authority.listAgentExtensionPolicyOverridesForRuntime({ workspaceId: "ws_acme" })).toEqual([
      { id: "extension-a", scope: "org", enabled: false, reason: "organization disabled" },
      { id: "extension-a", scope: "workspace", enabled: true },
    ])

    await Promise.all([
      authority.setAgentExtensionPolicyOverride(alice, {
        workspaceId: "ws_acme", extensionId: "extension-c", scope: "workspace", enabled: false,
      }),
      authority.setAgentExtensionPolicyOverride(alice, {
        workspaceId: "ws_acme", extensionId: "extension-c", scope: "workspace", enabled: false,
      }),
    ])
    const count = await database.prepare(`
      select count(*) as count from agent_extension_policy_overrides
      where deployment_id = 'deployment-a' and scope = 'workspace' and scope_key = 'ws_acme' and extension_id = 'extension-c'
    `).first<{ count: number }>()
    expect(count?.count).toBe(1)
    await authority.deleteAgentExtensionPolicyOverride(alice, {
      workspaceId: "ws_acme", extensionId: "extension-c", scope: "workspace",
    })
    await authority.deleteAgentExtensionPolicyOverride(alice, {
      workspaceId: "ws_acme", extensionId: "extension-c", scope: "workspace",
    })
  })
})

describe("D1 bounded audit authority", () => {
  test("attributes only authorized workspaces, strips arbitrary/secret metadata, remains append-only, and retains a fixed cap", async () => {
    const { authority, database, alice, outsider } = await tenantFixture()
    let id = 0
    let now = 1_900_000_000_000
    const audit = new D1AuditAuthority(database, {
      deploymentId: "deployment-a",
      retentionLimit: 3,
      randomId: () => `audit_${String(++id).padStart(3, "0")}`,
      now: () => ++now,
    })

    await audit.auditAllow(alice, {
      action: "runtime_access_token.minted",
      workspaceId: "ws_acme",
      metadata: {
        hostId: "host-a",
        jti: "jti-a",
        accessToken: "must-not-persist",
        nested: { secret: "must-not-persist" },
        ownerSubject: "provider-subject-must-not-persist",
      },
    })
    await audit.auditDeny(outsider, {
      action: "workspaces.open.denied",
      reason: "workspace_authorization_denied",
      workspaceId: "ws_acme",
      metadata: { retryAfterMs: 1000 },
    })
    await audit.auditDeny(undefined, {
      action: "runtime_access_token.denied",
      reason: "missing_auth",
      metadata: { hostId: "anonymous-host" },
    })

    const initial = await database.prepare(`
      select event_id, user_id, actor_id, workspace_id, unverified_attempted_workspace_id, metadata_json
      from authority_audit_events order by event_id
    `).all<{
      event_id: string
      user_id: string | null
      actor_id: string | null
      workspace_id: string | null
      unverified_attempted_workspace_id: string | null
      metadata_json: string | null
    }>()
    expect(initial.results[0]).toMatchObject({
      workspace_id: "ws_acme",
      unverified_attempted_workspace_id: null,
      metadata_json: '{"hostId":"host-a","jti":"jti-a"}',
    })
    expect(initial.results[1]).toMatchObject({
      workspace_id: null,
      unverified_attempted_workspace_id: "ws_acme",
      metadata_json: '{"retryAfterMs":1000}',
    })
    expect(initial.results[2]).toMatchObject({ user_id: null, actor_id: null, workspace_id: null })
    await expect(database.prepare(`update authority_audit_events set action = 'forged' where event_id = 'audit_001'`).run())
      .rejects.toThrow(/append-only/)

    await Promise.all(Array.from({ length: 8 }, (_, index) => audit.auditAllow(alice, {
      action: `retention.${index}`,
      metadata: { hostId: `host-${index}` },
    })))
    const retained = await database.prepare(`
      select count(*) as count from authority_audit_events where deployment_id = 'deployment-a'
    `).first<{ count: number }>()
    expect(retained?.count).toBe(3)
  })
})
