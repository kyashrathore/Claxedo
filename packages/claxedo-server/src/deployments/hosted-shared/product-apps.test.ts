import path from "node:path"
import { describe, expect, test, vi } from "vitest"
import { build } from "esbuild"
import { sourceClosure } from "@claxedo/server-core/platform/governance/source-closure"

import type { HostedControlPlane } from "../../authority/hosted-services"
import type { ControlPlaneServices } from "../../authority/services"
import type { BillingStore } from "../../billing/store-contract"
import { createInMemoryCliSessionTokenRegistry } from "@claxedo/server-core/platform/auth/cli-session-registry"
import { createUserDeployedProductApp } from "./user-deployed-product-app"
import { createClaxedoHostedProductApp } from "./claxedo-hosted-product-app"
import { testRequestAuthenticationAdapter } from "../../test-support/request-authentication"

const ROOT = path.resolve(import.meta.dirname, "../../..")

function plane(): HostedControlPlane {
  const sessionAuthority = {
    reserveSession: vi.fn(async (_auth: unknown, input: Record<string, unknown>) => ({ ...input, changed: true, state: "reserved" })),
    registerRuntimeSession: vi.fn(async () => ({})),
    markSessionRegistrationAmbiguous: vi.fn(async () => ({})),
    beginSessionCompensation: vi.fn(async () => ({})),
    completeSessionCompensation: vi.fn(async () => ({})),
    authorizeRuntimeSession: vi.fn(async () => undefined),
    runtimeAccessTokenActive: vi.fn(async () => ({ active: true })),
  }
  const services = {
    auth: {
      config: { enabled: true, issuer: "https://issuer.test", jwksUrl: "https://issuer.test/jwks" },
      verifier: vi.fn(async (token: string) => ({
        mode: "signed",
        user: { subject: token, tokenIdentifier: `issuer|${token}`, issuer: "https://issuer.test" },
      })),
    },
    relay: { relayUrl: "https://relay.test", resolverToken: "resolver-token" },
    sandbox: {},
    authority: {
      resolveOrgId: vi.fn(async () => "org-1"),
      usersMe: vi.fn(async () => ({ id: "user-1", user_id: "user-1" })),
      listWorkspaces: vi.fn(async () => []),
      auditAllow: vi.fn(async () => ({})),
    },
    telemetry: { capture: vi.fn() },
    localExecution: { enabled: false },
  } as unknown as ControlPlaneServices
  return {
    services,
    relayUrl: "https://relay.test",
    resolverToken: "resolver-token",
    safetyLimits: {
      connectionRateLimit: 6,
      connectionRateLimitWindowMs: 60_000,
      controlPlaneRateLimit: 120,
      controlPlaneRateLimitWindowMs: 60_000,
      defaultRequestRateLimit: 10_000,
      defaultRequestRateLimitWindowMs: 60_000,
      sandboxMaxRetryCount: 5,
    },
    relayTargetLookup: vi.fn(async () => null),
    cliSessionTokenRegistry: createInMemoryCliSessionTokenRegistry(),
    privateSessionAuthority: sessionAuthority,
    runtimeSessionAuthority: sessionAuthority,
    env: { CLAXEDO_DEPLOYMENT_MODE: "hosted" },
  } as unknown as HostedControlPlane
}

const core = {
  authentication: testRequestAuthenticationAdapter(),
  liveSyncRoom: {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async () => new Response(null, { status: 503 }) }),
  },
  sharedRateLimitStore: { periodSeconds: 60, check: async () => ({ allowed: true }) },
  serviceCatalog: async () => [],
}

const billingStore: BillingStore = {
  entitlementState: vi.fn(async () => ({
    found: true as const,
    org_id: "org-1",
    plan: "pro" as const,
    subscription_status: "active",
  })),
  applyPolarState: vi.fn(async () => ({ results: [], unresolved: [] })),
  checkoutContext: vi.fn(async () => ({ org_id: "org-1", role: "owner", member_count: 1 })),
  listReconcileFlagged: vi.fn(async () => []),
  listDeletedWithSubscription: vi.fn(async () => []),
}

describe("static hosted product roots", () => {
  test("user-deployed is one-org multiplayer and has no billing route", async () => {
    const app = createUserDeployedProductApp(plane(), {
      ...core,
      cloudWorkspaceAdmission: async () => undefined,
      userDeployedIdentityAdmission: {
        admit: vi.fn(async () => ({ state: "active" as const, userId: "user-2", actorId: "actor-2" })),
      },
    })
    expect(app.routes.map((route) => route.path).filter((route) => route.startsWith("/api/billing"))).toEqual([])
    const response = await app.fetch(new Request("https://core.test/api/claxedo/mode"))
    expect(await response.json()).toMatchObject({
      product: { productPosture: "user-deployed", organizationPolicy: "single-org", billing: "absent", multiplayer: true },
    })
  })

  test("Claxedo-hosted is multi-org multiplayer and statically mounts Polar billing", async () => {
    const app = createClaxedoHostedProductApp(plane(), { ...core, billingStore })
    expect(app.routes.map((route) => route.path)).toContain("/api/billing/checkout")
    const response = await app.fetch(new Request("https://core.test/api/claxedo/mode"))
    expect(await response.json()).toMatchObject({
      product: { productPosture: "claxedo-hosted", organizationPolicy: "multi-org", billing: "polar", multiplayer: true },
    })
  })

  test("proves billing is a static hosted-only edge and is never selected inside routes", () => {
    const user = sourceClosure({
      entry: path.join(ROOT, "src/deployments/hosted-shared/user-deployed-product-app.ts"),
      root: ROOT,
      runtimeOnly: true,
    })
    const hosted = sourceClosure({
      entry: path.join(ROOT, "src/deployments/hosted-shared/claxedo-hosted-product-app.ts"),
      root: ROOT,
      runtimeOnly: true,
    })
    expect(user.unresolved).toEqual([])
    expect(user.opaque).toEqual([])
    expect(user.modules.map((module) => module.relative).filter((file) => file.startsWith("src/billing/"))).toEqual([])
    expect(user.packages).not.toContain("@polar-sh/sdk")

    expect(hosted.unresolved).toEqual([])
    expect(hosted.opaque).toEqual([])
    expect(hosted.modules.map((module) => module.relative)).toContain("src/billing/routes.ts")
    expect(hosted.modules.map((module) => module.relative)).not.toContain("src/billing/store.ts")
    expect(hosted.packages).toContain("@polar-sh/sdk")
  })

  test("emits a user-deployed core bundle without Polar or Documents implementation code", async () => {
    const result = await build({
      entryPoints: [path.join(ROOT, "src/deployments/hosted-shared/user-deployed-product-app.ts")],
      bundle: true,
      format: "esm",
      platform: "neutral",
      target: "es2022",
      conditions: ["workerd", "worker", "import"],
      external: ["node:*"],
      write: false,
      metafile: true,
      logLevel: "silent",
    })
    const implementationInputs = Object.keys(result.metafile.inputs).filter((file) =>
      ["/documents/", "/billing/"].some((part) => file.replaceAll("\\", "/").includes(part)),
    )
    expect(implementationInputs).toEqual([])
    const emitted = result.outputFiles.map((file) => file.text).join("\n")
    expect(emitted).not.toMatch(/POLAR_ACCESS_TOKEN/)
  })
})
