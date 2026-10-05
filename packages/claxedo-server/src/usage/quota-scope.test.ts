import { afterAll, beforeAll, expect, test } from "vitest"
import { CREDENTIALS_KEK_ENV } from "@claxedo/server-core/credentials/envelope"
import { createUsageQuotaReader } from "@claxedo/server-core/usage/quota"
import { UsageRoutes } from "@claxedo/server-core/usage/routes"
import { tokenTrackerPricing } from "@claxedo/server-core/usage/adapters/token-tracker-pricing"
import { HOSTED_CREDENTIALS_FLAG, hostedOrgCredentials } from "../credentials/worker/index"
import { orgRoutedCredentials } from "../credentials/worker/org-routed"
import { miniflareControlPlaneDatabase, type ControlPlaneDatabase } from "../test-support/control-plane-migrations"
import { createD1UsageLedger } from "./adapters/d1-usage-ledger"

const ENV = { [CREDENTIALS_KEK_ENV]: Buffer.alloc(32, 5).toString("base64"), [HOSTED_CREDENTIALS_FLAG]: "1" }

let controlPlane: ControlPlaneDatabase
beforeAll(async () => { controlPlane = await miniflareControlPlaneDatabase() })
afterAll(async () => { await controlPlane.dispose() })

type Quota = { status: string; snapshot?: { accounts: Array<{ label?: string; credentialId?: string; windows: unknown[] }> } }

test("the hosted usage limits show a member their own accounts and the organization's, never another member's", async () => {
  const credentials = (orgId: string) => hostedOrgCredentials(orgId, { database: controlPlane.database, env: ENV })
  const routes = UsageRoutes({
    ledger: createD1UsageLedger({ database: controlPlane.database }),
    identity: async (request) => {
      const person = request.headers.get("x-test-person")
      return person ? { org_id: request.headers.get("x-test-org") ?? "org_acme", user_id: person } : undefined
    },
    quota: createUsageQuotaReader({ credentials: orgRoutedCredentials(credentials, async () => {}) }),
    pricing: tokenTrackerPricing("bundled"),
  })
  const store = credentials("org_acme")
  const subscription = (owner: string | null, label: string) => ({
    owner, provider_id: "claude-sdk", kind: "oauth_token" as const, source: "managed" as const, label, account_id: label, secret: `token-${label}`,
  })
  const alices = await store.putCredential(subscription("usr_alice", "alice@acme.test"))
  await store.putCredential(subscription("usr_bob", "bob@acme.test"))
  await store.putCredential(subscription(null, "team@acme.test"))
  await credentials("org_other").putCredential(subscription("usr_bob", "bob@other.test"))
  await store.updateCredentialUsage!(alices.id, [{ window: "session", usedPercent: 60, resetsAt: 2_000_000_000_000 }], 1_900_000_000_000)

  const limits = async (person: string, org?: string) => {
    const until = Date.now()
    const response = await routes.request(`/?view=quota&since=${until - 86_400_000}&until=${until}`, {
      headers: { "x-test-person": person, ...(org ? { "x-test-org": org } : {}) },
    })
    expect(response.status).toBe(200)
    const text = await response.text()
    return { text, quota: (JSON.parse(text) as { quota: Quota }).quota }
  }
  const labels = (quota: Quota) => quota.snapshot?.accounts.map((account) => account.label).sort()

  const bob = await limits("usr_bob")
  expect(labels(bob.quota)).toEqual(["bob@acme.test", "team@acme.test"])
  expect(bob.text).not.toContain("alice@acme.test")
  expect(bob.text).not.toContain("bob@other.test")

  const alice = await limits("usr_alice")
  expect(labels(alice.quota)).toEqual(["alice@acme.test", "team@acme.test"])
  expect(alice.quota.status).toBe("available")
  expect(alice.quota.snapshot?.accounts.find((account) => account.credentialId === alices.id)?.windows)
    .toEqual([{ window: "session", usedPercent: 60, resetsAt: 2_000_000_000_000 }])

  expect(labels((await limits("usr_bob", "org_other")).quota)).toEqual(["bob@other.test"])
  expect(labels((await limits("usr_carol")).quota)).toEqual(["team@acme.test"])
})
