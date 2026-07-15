import BetterSqlite3 from "better-sqlite3"
import { afterEach, describe, expect, test, vi } from "vitest"
import { createSqliteIntakeStores } from "../src/adapters/sqlite/intake-store"
import { createSqliteWebhookIntakeStore } from "../src/adapters/sqlite/webhook-intake-store"
import { createWebhookIntakeService, WebhookLeaseLostError, type VerifiedWorkSourceSignal } from "../src/application/webhook-intake-service"
import { ConnectionIDSchema, type WorkGraphContext } from "../src/contracts"

const databases: BetterSqlite3.Database[] = []
const connectionId = ConnectionIDSchema.parse("team_connection")

afterEach(() => {
  vi.restoreAllMocks()
  databases.splice(0).forEach((database) => database.close())
})

describe("durable verified webhook intake", () => {
  test("routes only matching owner Source Views and deduplicates across service restarts", async () => {
    const database = openDatabase()
    const intake = createSqliteIntakeStores(database)
    await Promise.all([
      intake.sourceViews.create(context("alice"), view("alice", "alice_view", { repo: "claxedo/cloud", state: "open" })),
      intake.sourceViews.create(context("bob"), view("bob", "bob_view", { repo: "claxedo/desktop" })),
      intake.sourceViews.create(context("carol"), { ...view("carol", "carol_view", { repo: "claxedo/cloud" }), teamConnectionId: ConnectionIDSchema.parse("other_connection") }),
    ])
    const refresh = vi.fn(async (_context: WorkGraphContext, _sourceViewId: string) => undefined)
    const signal = delivery()

    await expect(createWebhookIntakeService({ store: createSqliteWebhookIntakeStore(database), refresh }).receive(signal))
      .resolves.toEqual({ accepted: true, reason: "processed", refreshed: 1 })
    await expect(createWebhookIntakeService({ store: createSqliteWebhookIntakeStore(database), refresh }).receive(signal))
      .resolves.toEqual({ accepted: false, reason: "already_processed", refreshed: 0 })

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh.mock.calls[0]?.[0]).toMatchObject({ ownerUserId: "alice", actor: { type: "system" }, access: { mode: "owner" } })
    expect(refresh.mock.calls[0]?.[1]).toBe("alice_view")
    expect(database.prepare("SELECT connection_id, provider, delivery_id, status FROM wg_v2_webhook_deliveries").all()).toEqual([{
      connection_id: "team_connection",
      provider: "github",
      delivery_id: "delivery_1",
      status: "completed",
    }])
  })

  test("routes one Linear delivery through a shared team Connection using each user's filter", async () => {
    const database = openDatabase()
    const intake = createSqliteIntakeStores(database)
    await Promise.all([
      intake.sourceViews.create(context("alice"), linearView("alice", "alice_linear", "ENG")),
      intake.sourceViews.create(context("bob"), linearView("bob", "bob_linear", "DESIGN")),
    ])
    const refresh = vi.fn(async (_context: WorkGraphContext, _sourceViewId: string) => undefined)
    const signal: VerifiedWorkSourceSignal = {
      organizationId: "organization",
      connectionId,
      provider: "linear",
      deliveryId: "linear-delivery-1",
      event: "Issue",
      attributes: { team: ["team-id", "ENG"] },
      receivedAt: 2,
    }

    await expect(createWebhookIntakeService({ store: createSqliteWebhookIntakeStore(database), refresh }).receive(signal))
      .resolves.toEqual({ accepted: true, reason: "processed", refreshed: 1 })
    expect(refresh).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: "alice" }), "alice_linear")
  })

  test("uses verified Jira project identities to bound simple project-scoped JQL views", async () => {
    const database = openDatabase()
    const intake = createSqliteIntakeStores(database)
    await Promise.all([
      intake.sourceViews.create(context("alice"), jiraView("alice", "alice_jira", "project = CLOUD AND assignee = currentUser()")),
      intake.sourceViews.create(context("bob"), jiraView("bob", "bob_jira", "project IN (DESIGN, OPS)")),
    ])
    const refresh = vi.fn(async (_context: WorkGraphContext, _sourceViewId: string) => undefined)
    await expect(createWebhookIntakeService({ store: createSqliteWebhookIntakeStore(database), refresh }).receive({
      organizationId: "organization",
      connectionId,
      provider: "jira",
      deliveryId: "jira-delivery-1",
      event: "jira:issue_updated",
      attributes: { project: ["10000", "CLOUD"] },
      receivedAt: 2,
    })).resolves.toEqual({ accepted: true, reason: "processed", refreshed: 1 })
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: "alice" }), "alice_jira")
  })

  test("does not persist raw payload or attributes in the durable receipt", async () => {
    const database = openDatabase()
    await createWebhookIntakeService({ store: createSqliteWebhookIntakeStore(database), refresh: async () => undefined }).receive(delivery())
    const columns = database.prepare("PRAGMA table_info(wg_v2_webhook_deliveries)").all() as Array<{ name: string }>
    expect(columns.map((column) => column.name)).not.toContain("payload")
    expect(columns.map((column) => column.name)).not.toContain("attributes")
  })

  test("persists failure and lets a provider retry reacquire after restart", async () => {
    const database = openDatabase()
    const intake = createSqliteIntakeStores(database)
    await intake.sourceViews.create(context("alice"), view("alice", "alice_view", { repo: "claxedo/cloud" }))
    const failedRefresh = vi.fn(async () => { throw new Error("provider temporarily unavailable") })

    await expect(createWebhookIntakeService({ store: createSqliteWebhookIntakeStore(database), refresh: failedRefresh }).receive(delivery()))
      .rejects.toThrow("temporarily unavailable")
    expect(database.prepare("SELECT status, attempt_count FROM wg_v2_webhook_deliveries").get()).toEqual({ status: "failed", attempt_count: 1 })

    const recoveredRefresh = vi.fn(async () => undefined)
    await expect(createWebhookIntakeService({ store: createSqliteWebhookIntakeStore(database), refresh: recoveredRefresh }).receive(delivery()))
      .resolves.toEqual({ accepted: true, reason: "processed", refreshed: 1 })
    expect(recoveredRefresh).toHaveBeenCalledTimes(1)
    expect(database.prepare("SELECT status, attempt_count FROM wg_v2_webhook_deliveries").get()).toEqual({ status: "completed", attempt_count: 2 })
  })

  test("fences stale completion after an expired delivery lease is reacquired", async () => {
    const database = openDatabase()
    const store = createSqliteWebhookIntakeStore(database)
    vi.spyOn(Date, "now").mockReturnValue(1_000)
    const first = await store.begin(delivery())
    expect(first).toMatchObject({ state: "acquired" })
    if (first.state !== "acquired") throw new Error("Expected the first delivery lease")

    vi.mocked(Date.now).mockReturnValue(62_000)
    const second = await store.begin(delivery())
    expect(second).toMatchObject({ state: "acquired" })
    if (second.state !== "acquired") throw new Error("Expected the replacement delivery lease")
    await expect(store.complete(delivery(), first.leaseId)).resolves.toBe(false)
    expect(database.prepare("SELECT status, claimed_by FROM wg_v2_webhook_deliveries").get()).toEqual({
      status: "pending",
      claimed_by: second.leaseId,
    })
    await expect(store.complete(delivery(), second.leaseId)).resolves.toBe(true)
    expect(database.prepare("SELECT status, claimed_by FROM wg_v2_webhook_deliveries").get()).toEqual({
      status: "completed",
      claimed_by: null,
    })
  })

  test("does not report processing success when durable lease completion is rejected", async () => {
    await expect(createWebhookIntakeService({
      store: {
        begin: async () => ({ state: "acquired", leaseId: "stale" }),
        listSourceViews: async () => [],
        complete: async () => false,
        fail: async () => false,
      },
      refresh: async () => undefined,
    }).receive(delivery())).rejects.toBeInstanceOf(WebhookLeaseLostError)
  })
})

function openDatabase() {
  const database = new BetterSqlite3(":memory:")
  databases.push(database)
  return database
}

function context(ownerUserId: string): WorkGraphContext {
  return { organizationId: "organization" as never, ownerUserId: ownerUserId as never, actor: { type: "user", id: ownerUserId as never }, requestId: `request_${ownerUserId}` as never, access: { mode: "owner" } }
}

function view(ownerUserId: string, id: string, filters: Record<string, string>) {
  return {
    id,
    ownerUserId,
    version: 1,
    teamConnectionId: connectionId,
    provider: "github" as const,
    providerUserId: ownerUserId,
    filters,
    syncPolicy: "announce" as const,
    status: "active" as const,
    createdAt: 1,
    updatedAt: 1,
  }
}

function linearView(ownerUserId: string, id: string, team: string) {
  return {
    ...view(ownerUserId, id, { team }),
    provider: "linear" as const,
  }
}

function jiraView(ownerUserId: string, id: string, jql: string) {
  return {
    ...view(ownerUserId, id, { jql }),
    provider: "jira" as const,
  }
}

function delivery(): VerifiedWorkSourceSignal {
  return {
    organizationId: "organization",
    connectionId,
    provider: "github",
    deliveryId: "delivery_1",
    event: "issues",
    attributes: { repo: "claxedo/cloud", state: "closed", labels: [] },
    receivedAt: 2,
  }
}
