import { createServer, type Server } from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import {
  ActorIDSchema,
  ConnectionIDSchema,
  createIntakeCandidatePageCursor,
  OwnerUserIDSchema,
  RequestIDSchema,
  readIntakeCandidatePageCursor,
  StreamIDSchema,
  type WorkGraphContext,
} from "../src/contracts"
import { createGitHubSourceIssueConnector } from "../src/connectors/github/source-view"
import { SourceIssueUnauthorizedError } from "../src/connectors/interface"
import { IntakeCandidateVersionConflictError, IntakeStateError, createIntakeService, type IntakeCandidate, type IntakeCandidateStore } from "../src/application/intake-service"
import { createMatchingService } from "../src/application/matching-service"
import { SOURCE_VIEW_FILTER_KEYS, SourceViewFilterError, SourceViewInUseError, SourceViewVersionConflictError, createSourceViewService, providerMatchesIntegration, type SourceView, type SourceViewStore } from "../src/application/source-view-service"
import type { ConnectionsPort } from "../src/ports"

const servers: Server[] = []
afterEach(() => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))))

describe("Connections-backed personal intake", () => {
  it("publishes the complete provider filter vocabulary", () => {
    expect(SOURCE_VIEW_FILTER_KEYS).toEqual({
      github: ["repo", "state", "labels"],
      linear: ["team"],
      jira: ["jql"],
    })
  })

  it("rejects unsupported and credential-shaped filters before the store sees them", async () => {
    const state = memoryState()
    const sourceViews = createSourceViewService({ store: state.views, connections: teamConnections("connection-secret"), ids: ids("view"), clock: fixedClock })
    const create = (filters: Readonly<Record<string, string>>) => sourceViews.create(context("alice"), {
      teamConnectionId,
      provider: "github",
      providerUserId: "alice-gh",
      filters,
    })

    await expect(create({ token: "connection-secret" })).rejects.toBeInstanceOf(SourceViewFilterError)
    await expect(create({ repo: "github_pat_1234567890abcdef" })).rejects.toBeInstanceOf(SourceViewFilterError)
    await expect(create({ metadata: { authorization: "Bearer connection-secret" } } as unknown as Record<string, string>)).rejects.toBeInstanceOf(SourceViewFilterError)
    await expect(create({ project: "cloud" })).rejects.toThrow('Supported filters: repo, state, labels')
    expect(state.viewRows.size).toBe(0)
  })

  it("maps Jira source views to the Atlassian integration explicitly", () => {
    expect(providerMatchesIntegration("jira", "atlassian")).toBe(true)
    expect(providerMatchesIntegration("jira", "github")).toBe(false)
    expect(providerMatchesIntegration("github", "atlassian")).toBe(false)
  })

  it("updates the complete personal Source View state with CAS and exact retry semantics", async () => {
    const state = memoryState()
    const sourceViews = createSourceViewService({ store: state.views, connections: teamConnections("shared-team-token"), ids: ids("view"), clock: fixedClock })
    const created = await sourceViews.create(context("alice"), {
      teamConnectionId,
      provider: "github",
      providerUserId: "alice-gh",
      filters: { repo: "acme/cloud" },
      syncPolicy: "announce",
    })
    const update = {
      expectedVersion: 1,
      providerUserId: "alice-updated",
      filters: { labels: "launch", repo: "acme/cloud" },
      syncPolicy: "full" as const,
      status: "paused" as const,
    }

    const updated = await sourceViews.update(context("alice"), created.id, update)
    expect(updated).toMatchObject({
      id: created.id,
      version: 2,
      teamConnectionId,
      provider: "github",
      providerUserId: "alice-updated",
      filters: { labels: "launch", repo: "acme/cloud" },
      syncPolicy: "full",
      status: "paused",
    })
    expect(await sourceViews.update(context("alice"), created.id, update)).toEqual(updated)
    await expect(sourceViews.update(context("alice"), created.id, { ...update, status: "active" }))
      .rejects.toBeInstanceOf(SourceViewVersionConflictError)
  })

  it("dismisses and restores only unorganized candidates with version fencing", async () => {
    const state = memoryState()
    state.candidateRows.set("alice:candidate-1", {
      candidateKind: "session",
      id: "candidate-1",
      ownerUserId: "alice",
      version: 1,
      sessionId: "session-1",
      title: "Investigate",
      body: "Finding",
      state: "unorganized",
      createdAt: fixedClock.now(),
      updatedAt: fixedClock.now(),
    })
    const intake = intakeService(state, teamConnections("shared-team-token"), "http://unused.test")

    const dismissed = await intake.dismiss(context("alice"), "candidate-1", 1)
    expect(dismissed).toMatchObject({ state: "dismissed", version: 2 })
    expect(await intake.dismiss(context("alice"), "candidate-1", 1)).toEqual(dismissed)
    await expect(intake.restore(context("alice"), "candidate-1", 1)).rejects.toBeInstanceOf(IntakeCandidateVersionConflictError)
    expect(await intake.restore(context("alice"), "candidate-1", 2)).toMatchObject({ state: "unorganized", version: 3 })
    await expect(intake.restore(context("alice"), "candidate-1", 3)).rejects.toBeInstanceOf(IntakeStateError)
  })

  it("deletes a Source View only after its disposable candidates are dismissed", async () => {
    const state = memoryState()
    const sourceViews = createSourceViewService({ store: state.views, connections: teamConnections("shared-team-token"), ids: ids("view"), clock: fixedClock })
    const created = await sourceViews.create(context("alice"), {
      teamConnectionId,
      provider: "github",
      providerUserId: "alice-gh",
      filters: { repo: "acme/cloud" },
    })
    state.candidateRows.set("alice:candidate-1", {
      candidateKind: "external_issue",
      id: "candidate-1",
      ownerUserId: "alice",
      version: 1,
      sourceViewId: created.id,
      provider: "github",
      externalId: "issue-1",
      title: "Ship",
      body: "Finding",
      externalStatus: "open",
      state: "unorganized",
      createdAt: fixedClock.now(),
      updatedAt: fixedClock.now(),
    })

    await expect(sourceViews.delete(context("alice"), created.id, 1)).rejects.toBeInstanceOf(SourceViewInUseError)
    await intakeService(state, teamConnections("shared-team-token"), "http://unused.test").dismiss(context("alice"), "candidate-1", 1)
    expect(await sourceViews.delete(context("alice"), created.id, 1)).toMatchObject({ id: created.id })
    expect(await sourceViews.read(context("alice"), created.id)).toBeUndefined()
    expect(state.candidateRows.size).toBe(0)
  })
  it("uses one team credential while isolating each owner's mapping, filters, and candidates", async () => {
    const observed: Array<{ authorization: string | undefined; query: string }> = []
    const provider = await fakeProvider((request, response) => {
      observed.push({ authorization: request.headers.authorization, query: request.url ?? "" })
      const query = new URL(request.url ?? "/", "http://provider").searchParams.get("q") ?? ""
      const owner = query.includes("assignee:alice-gh") ? "alice" : "bob"
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ items: [{ id: owner === "alice" ? 1001 : 1002, number: owner === "alice" ? 1 : 2, title: `${owner} issue`, body: "launch", state: "open", updated_at: "2026-07-13T00:00:00Z" }] }))
    })
    const state = memoryState()
    const connections = teamConnections("shared-team-token")
    const sourceViews = createSourceViewService({ store: state.views, connections, ids: ids("view"), clock: fixedClock })
    const aliceView = await sourceViews.create(context("alice"), {
      teamConnectionId,
      provider: "github",
      providerUserId: "alice-gh",
      filters: { repo: "acme/alice" },
    })
    const bobView = await sourceViews.create(context("bob"), {
      teamConnectionId,
      provider: "github",
      providerUserId: "bob-gh",
      filters: { repo: "acme/bob" },
    })
    const intake = intakeService(state, connections, provider)

    const [alice, bob] = await Promise.all([
      intake.refresh(context("alice"), aliceView.id),
      intake.refresh(context("bob"), bobView.id),
    ])

    expect(alice.candidates.map((candidate) => candidate.title)).toEqual(["alice issue"])
    expect(bob.candidates.map((candidate) => candidate.title)).toEqual(["bob issue"])
    expect(await intake.list(context("alice"))).toHaveLength(1)
    expect(await intake.list(context("bob"))).toHaveLength(1)
    expect(observed.every((entry) => entry.authorization === "Bearer shared-team-token")).toBe(true)
    expect(observed.some((entry) => decodeURIComponent(entry.query).includes("repo:acme/alice"))).toBe(true)
    expect(JSON.stringify([...state.viewRows.values(), ...state.candidateRows.values()])).not.toContain("shared-team-token")
  })

  it("normalizes idempotently, requires staging, and applies announce once with a durable receipt", async () => {
    const effects: string[] = []
    const provider = await fakeProvider((request, response, body) => {
      if (request.method === "POST") {
        effects.push(body)
        response.setHeader("content-type", "application/json")
        response.end("{}")
        return
      }
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ items: [{ id: 1042, number: 42, title: "Ship cloud", body: "finish launch", state: "open", updated_at: "2026-07-13T00:00:00Z" }] }))
    })
    const state = memoryState()
    const connections = teamConnections("rotating-secret")
    const sourceViews = createSourceViewService({ store: state.views, connections, ids: ids("view"), clock: fixedClock })
    const view = await sourceViews.create(context("alice"), {
      teamConnectionId,
      provider: "github",
      providerUserId: "alice-gh",
      filters: { repo: "acme/cloud" },
      syncPolicy: "announce",
    })
    const intake = intakeService(state, connections, provider)
    const first = await intake.refresh(context("alice"), view.id)
    const second = await intake.refresh(context("alice"), view.id)
    expect(first.created).toBe(1)
    expect(second.updated).toBe(1)
    expect(await intake.list(context("alice"))).toHaveLength(1)

    const staged = await intake.stage(context("alice"), first.candidates[0]!.id)
    expect(staged).toMatchObject({ state: "staged", admissionProposalId: "proposal", source: { workSourceId: "source", revisionId: "revision" } })
    const confirmed = updateCandidate(state.candidateRows, context("alice"), staged.id, { state: "confirmed" })

    expect(await intake.syncExternal(context("alice"), { candidateId: confirmed.id, idempotencyKey: "announce-1", summary: "WorkGraph is tracking this" })).toEqual({ applied: true, reason: "announce" })
    expect(await intake.syncExternal(context("alice"), { candidateId: confirmed.id, idempotencyKey: "announce-1", summary: "duplicate" })).toEqual({ applied: false, reason: "already_applied" })
    expect(effects).toHaveLength(1)
    expect(JSON.stringify([...state.receiptKeys])).not.toContain("rotating-secret")
  })

  it("reports provider 401 without exposing or persisting the token", async () => {
    const provider = await fakeProvider((_request, response) => {
      response.statusCode = 401
      response.end("secret rejected")
    })
    const state = memoryState()
    const reported: string[] = []
    const connections = teamConnections("never-print-this", reported)
    const sourceViews = createSourceViewService({ store: state.views, connections, ids: ids("view"), clock: fixedClock })
    const view = await sourceViews.create(context("alice"), {
      teamConnectionId,
      provider: "github",
      providerUserId: "alice-gh",
      filters: { repo: "acme/cloud" },
    })
    const intake = intakeService(state, connections, provider)
    await expect(intake.refresh(context("alice"), view.id)).rejects.toMatchObject({
      name: "SourceIssueUnauthorizedError",
      code: "source_issue_provider_unauthorized",
      status: 401,
    } satisfies Partial<SourceIssueUnauthorizedError>)
    expect(reported).toEqual(["github_401"])
    expect(JSON.stringify([...state.viewRows.values(), ...state.candidateRows.values()])).not.toContain("never-print-this")
  })

  it("releases a failed external effect for retry and allows only one concurrent winner", async () => {
    let attempts = 0
    let releaseFirst: (() => void) | undefined
    const provider = await fakeProvider((request, response) => {
      if (request.method !== "POST") {
        response.setHeader("content-type", "application/json")
        response.end(JSON.stringify({ items: [{ id: 1009, number: 9, title: "Retry sync", body: "", state: "open", updated_at: "2026-07-13T00:00:00Z" }] }))
        return
      }
      attempts++
      if (attempts === 1) {
        response.statusCode = 500
        response.end("failed")
        return
      }
      if (attempts === 2) {
        releaseFirst = () => response.end("{}")
        return
      }
      response.end("{}")
    })
    const state = memoryState()
    const connections = teamConnections("secret")
    const sourceViews = createSourceViewService({ store: state.views, connections, ids: ids("view"), clock: fixedClock })
    const view = await sourceViews.create(context("alice"), { teamConnectionId, provider: "github", providerUserId: "alice-gh", filters: { repo: "acme/cloud" } })
    const intake = intakeService(state, connections, provider)
    const refreshed = await intake.refresh(context("alice"), view.id)
    const staged = await intake.stage(context("alice"), refreshed.candidates[0]!.id)
    const confirmed = updateCandidate(state.candidateRows, context("alice"), staged.id, { state: "confirmed" })
    await expect(intake.syncExternal(context("alice"), { candidateId: confirmed.id, idempotencyKey: "retry-key", summary: "first" })).rejects.toThrow("github source request failed (500)")

    const winner = intake.syncExternal(context("alice"), { candidateId: confirmed.id, idempotencyKey: "retry-key", summary: "second" })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const concurrent = await intake.syncExternal(context("alice"), { candidateId: confirmed.id, idempotencyKey: "retry-key", summary: "concurrent" })
    expect(concurrent).toEqual({ applied: false, reason: "in_progress" })
    releaseFirst?.()
    expect(await winner).toEqual({ applied: true, reason: "announce" })
    expect(attempts).toBe(2)
  })

  it("reuses the exact source and proposal when candidate binding persistence fails", async () => {
    const provider = await fakeProvider((_request, response) => {
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ items: [{ id: 1007, number: 7, title: "Crash safe", body: "", state: "open", updated_at: "2026-07-13T00:00:00Z" }] }))
    })
    const state = memoryState()
    const connections = teamConnections("secret")
    const sourceViews = createSourceViewService({ store: state.views, connections, ids: ids("view"), clock: fixedClock })
    const view = await sourceViews.create(context("alice"), { teamConnectionId, provider: "github", providerUserId: "alice-gh", filters: { repo: "acme/cloud" } })
    let failStage = true
    const executions = new Map<string, Awaited<ReturnType<Parameters<typeof createIntakeService>[0]["commands"]["execute"]>>>()
    let creations = 0
    const intake = intakeService(state, connections, provider, {
      candidates: {
        ...state.candidates,
        stage: async (...args) => {
          if (failStage) {
            failStage = false
            throw new Error("disk interruption")
          }
          return state.candidates.stage(...args)
        },
      },
      commands: {
        execute: async (_context, request) => {
          const existing = executions.get(request.operationId)
          if (existing) return existing
          creations++
          const created = commandResult(request)
          executions.set(request.operationId, created)
          return created
        },
      },
    })
    const refreshed = await intake.refresh(context("alice"), view.id)
    await expect(intake.stage(context("alice"), refreshed.candidates[0]!.id)).rejects.toThrow("disk interruption")
    expect(await intake.stage(context("alice"), refreshed.candidates[0]!.id)).toMatchObject({ admissionProposalId: "proposal" })
    expect(creations).toBe(2)
  })
})

describe("bounded stream matching", () => {
  it("does not load older memory when recent context has a high-confidence match", async () => {
    let olderReads = 0
    const matching = createMatchingService({
      streams: {
        recent: async () => [{ id: StreamIDSchema.parse("recent"), title: "Ship cloud", summary: "launch claxedo", pinned: false, lastActivityAt: fixedClock.now() }],
        pinned: async () => [],
        olderMemories: async () => (olderReads++, []),
      },
      clock: fixedClock,
    })
    const result = await matching.suggest(context("alice"), { title: "Ship cloud", body: "launch claxedo" })
    expect(result.recommendation).toMatchObject({ streamId: "recent", confidence: "high" })
    expect(result.expandedOlderMemories).toBe(false)
    expect(olderReads).toBe(0)
  })

  it("loads bounded recent, pinned and memory-only sets and caps older confidence", async () => {
    const limits: number[] = []
    const matching = createMatchingService({
      streams: {
        recent: async (_context, limit) => (limits.push(limit), [{ id: StreamIDSchema.parse("recent"), title: "Database migration", summary: "schema rollout", pinned: false, lastActivityAt: fixedClock.now() }]),
        pinned: async (_context, limit) => (limits.push(limit), []),
        olderMemories: async (_context, limit) => (limits.push(limit), [{ id: StreamIDSchema.parse("old"), title: "Ship cloud", summary: "launch claxedo", pinned: false, lastActivityAt: 0, memoryOnly: true }]),
      },
      recentLimit: 3,
      pinnedLimit: 2,
      olderMemoryLimit: 1,
      clock: fixedClock,
    })
    const result = await matching.suggest(context("alice"), { title: "Ship cloud", body: "launch claxedo" })
    expect(limits).toEqual([3, 2, 1])
    expect(result.expandedOlderMemories).toBe(true)
    expect(result.recommendation).toMatchObject({ streamId: "old", confidence: "low" })
    expect(result.recommendation!.score).toBeLessThan(0.45)
    expect(result.recommendation!.explanation).toContain("Older stream memory")
  })
})

const teamConnectionId = ConnectionIDSchema.parse("connection-team")
const fixedClock = { now: () => Date.parse("2026-07-13T12:00:00Z") }

function context(owner: string): WorkGraphContext {
  return {
    ownerUserId: OwnerUserIDSchema.parse(owner),
    actor: { type: "user", id: ActorIDSchema.parse(owner) },
    requestId: RequestIDSchema.parse(`request-${owner}`),
    access: { mode: "owner" },
  }
}

function teamConnections(token: string, reported: string[] = []): ConnectionsPort {
  return {
    resolveCapabilities: async (_context, request) => request.connectionIds.includes(teamConnectionId) ? [{
      id: teamConnectionId,
      integrationId: "github",
      capability: "work-source",
      scope: "team",
      withAuthorization: async (use) => use({ token, tokenType: "bearer" }),
      reportAuthFailure: async (reason) => { reported.push(reason) },
    }] : [],
  }
}

function memoryState() {
  const viewRows = new Map<string, SourceView>()
  const candidateRows = new Map<string, IntakeCandidate>()
  const stageDrafts = new Map<string, Readonly<{ title: string; content: string }>>()
  const identities = new Map<string, string>()
  const receiptKeys = new Map<string, { state: "pending" | "completed" | "failed"; leaseId?: string }>()
  const views: SourceViewStore = {
    create: async (_context, view) => (viewRows.set(`${view.ownerUserId}:${view.id}`, view), view),
    read: async (ctx, id) => viewRows.get(`${ctx.ownerUserId}:${id}`),
    list: async (ctx) => [...viewRows.values()].filter((view) => view.ownerUserId === ctx.ownerUserId),
    update: async (ctx, id, input) => {
      const key = `${ctx.ownerUserId}:${id}`
      const current = viewRows.get(key)
      if (!current) return { ok: false, reason: "not_found" }
      const same = current.providerUserId === input.providerUserId
        && current.syncPolicy === input.syncPolicy
        && current.status === input.status
        && Object.keys(current.filters).length === Object.keys(input.filters).length
        && Object.entries(current.filters).every(([name, value]) => input.filters[name] === value)
      if (current.version !== input.expectedVersion) {
        if (current.version === input.expectedVersion + 1 && same) return { ok: true, view: current }
        return { ok: false, reason: "version_conflict" }
      }
      const updated = {
        ...current,
        providerUserId: input.providerUserId,
        filters: input.filters,
        syncPolicy: input.syncPolicy,
        status: input.status,
        version: current.version + 1,
        updatedAt: input.updatedAt,
      }
      viewRows.set(key, updated)
      return { ok: true, view: updated }
    },
    delete: async (ctx, id, input) => {
      const key = `${ctx.ownerUserId}:${id}`
      const current = viewRows.get(key)
      if (!current) return { ok: false, reason: "not_found" }
      if (current.version !== input.expectedVersion) return { ok: false, reason: "version_conflict" }
      const referenced = [...candidateRows.values()].filter((candidate) => candidate.ownerUserId === ctx.ownerUserId && candidate.candidateKind === "external_issue" && candidate.sourceViewId === id)
      if (referenced.some((candidate) => candidate.state !== "dismissed")) return { ok: false, reason: "in_use" }
      referenced.forEach((candidate) => candidateRows.delete(`${ctx.ownerUserId}:${candidate.id}`))
      Array.from(identities).filter(([, candidateId]) => referenced.some((candidate) => candidate.id === candidateId)).forEach(([identity]) => identities.delete(identity))
      viewRows.delete(key)
      return { ok: true, view: current }
    },
  }
  const candidates: IntakeCandidateStore = {
    upsertExternal: async (ctx, input) => {
      const existingId = identities.get(input.identityKey)
      const existing = existingId ? candidateRows.get(`${ctx.ownerUserId}:${existingId}`) : undefined
      if (existing) {
        if (existing.candidateKind !== "external_issue") throw new Error("External identity resolved to a Session candidate")
        const updated = existing.source ? existing : { ...input.candidate, id: existing.id, state: existing.state, createdAt: existing.createdAt }
        candidateRows.set(`${ctx.ownerUserId}:${existing.id}`, updated)
        return { candidate: updated, created: false }
      }
      identities.set(input.identityKey, input.candidate.id)
      candidateRows.set(`${ctx.ownerUserId}:${input.candidate.id}`, input.candidate)
      return { candidate: input.candidate, created: true }
    },
    read: async (ctx, id) => candidateRows.get(`${ctx.ownerUserId}:${id}`),
    list: async (ctx, sourceViewId) => [...candidateRows.values()].filter((candidate) => candidate.ownerUserId === ctx.ownerUserId && (!sourceViewId || (candidate.candidateKind === "external_issue" && candidate.sourceViewId === sourceViewId))),
    page: async (ctx, input) => {
      const after = input.after ? readIntakeCandidatePageCursor(input.after, ctx.ownerUserId, input.sourceViewId) : undefined
      const rows = [...candidateRows.values()]
        .filter((candidate) => candidate.ownerUserId === ctx.ownerUserId && candidate.state === "unorganized")
        .filter((candidate) => !input.sourceViewId || (candidate.candidateKind === "external_issue" && candidate.sourceViewId === input.sourceViewId))
        .filter((candidate) => !after || candidate.updatedAt < after.updatedAt || (candidate.updatedAt === after.updatedAt && candidate.id < after.candidateId))
        .sort((left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id))
      const page = rows.slice(0, input.limit)
      const hasMore = rows.length > input.limit
      return {
        candidates: page,
        hasMore,
        ...(hasMore ? { nextCursor: createIntakeCandidatePageCursor({
          ownerUserId: ctx.ownerUserId,
          ...(input.sourceViewId ? { sourceViewId: input.sourceViewId } : {}),
          updatedAt: page.at(-1)!.updatedAt,
          candidateId: page.at(-1)!.id,
        }) } : {}),
      }
    },
    prepareStage: async (ctx, id, draft) => {
      const candidate = candidateRows.get(`${ctx.ownerUserId}:${id}`)
      if (!candidate) throw new Error("Candidate not found")
      const frozen = stageDrafts.get(`${ctx.ownerUserId}:${id}`) ?? draft
      stageDrafts.set(`${ctx.ownerUserId}:${id}`, frozen)
      return { candidate, draft: frozen }
    },
    stage: async (ctx, id, admission) => updateCandidate(candidateRows, ctx, id, { state: "staged", source: admission.source, admissionProposalId: admission.proposalId }),
    transition: async (ctx, id, input) => {
      const current = candidateRows.get(`${ctx.ownerUserId}:${id}`)
      if (!current) return { ok: false, reason: "not_found" }
      if (current.version !== input.expectedVersion) {
        if (current.version === input.expectedVersion + 1 && current.state === input.to) return { ok: true, candidate: current }
        return { ok: false, reason: "version_conflict" }
      }
      if (current.state !== input.from) return { ok: false, reason: "invalid_state" }
      return { ok: true, candidate: updateCandidate(candidateRows, ctx, id, { state: input.to, version: current.version + 1, updatedAt: input.updatedAt }) }
    },
  }
  return { viewRows, candidateRows, receiptKeys, views, candidates }
}

function intakeService(
  state: ReturnType<typeof memoryState>,
  connections: ConnectionsPort,
  baseUrl: string,
  overrides: Partial<Pick<Parameters<typeof createIntakeService>[0], "candidates" | "commands">> = {},
) {
  return createIntakeService({
    sourceViews: state.views,
    candidates: overrides.candidates ?? state.candidates,
    receipts: {
      begin: async (_context, receipt) => {
        const current = state.receiptKeys.get(receipt.key)
        if (current?.state === "completed") return { state: "completed" }
        if (current?.state === "pending") return { state: "busy" }
        const leaseId = `${receipt.key}-lease`
        state.receiptKeys.set(receipt.key, { state: "pending", leaseId })
        return { state: "acquired", leaseId }
      },
      complete: async (_context, receipt) => {
        if (state.receiptKeys.get(receipt.key)?.leaseId === receipt.leaseId) state.receiptKeys.set(receipt.key, { state: "completed" })
      },
      fail: async (_context, receipt) => {
        if (state.receiptKeys.get(receipt.key)?.leaseId === receipt.leaseId) state.receiptKeys.set(receipt.key, { state: "failed" })
      },
    },
    commands: overrides.commands ?? { execute: async (_context, request) => commandResult(request) },
    connections,
    connectors: { get: (provider) => provider === "github" ? createGitHubSourceIssueConnector({ baseUrl }) : undefined },
    ids: ids("candidate"),
    clock: fixedClock,
  })
}

function commandResult(request: Parameters<Parameters<typeof createIntakeService>[0]["commands"]["execute"]>[1]) {
  return {
    ok: true as const,
    operationId: request.operationId,
    cursor: "cursor" as never,
    value: request.command.type === "create_work_source"
      ? { workSourceId: "source", revisionId: "revision" }
      : { proposalId: "proposal" },
  }
}

function ids(prefix: string) {
  let next = 0
  return { next: () => `${prefix}-${++next}` }
}

function updateCandidate(rows: Map<string, IntakeCandidate>, ctx: WorkGraphContext, id: string, patch: Partial<IntakeCandidate>) {
  const current = rows.get(`${ctx.ownerUserId}:${id}`)
  if (!current) throw new Error("Candidate not found")
  const updated = { ...current, ...patch } as IntakeCandidate
  rows.set(`${ctx.ownerUserId}:${id}`, updated)
  return updated
}

async function fakeProvider(handler: (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse, body: string) => void) {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
    request.on("end", () => handler(request, response, Buffer.concat(chunks).toString("utf8")))
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Provider did not bind")
  return `http://127.0.0.1:${address.port}`
}
