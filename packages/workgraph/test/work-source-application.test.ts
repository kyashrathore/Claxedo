import { describe, expect, it, vi } from "vitest"
import {
  createAttentionService,
  createWorkGraphAuthoringAdapter,
  createRecapService,
  createSessionIntakeService,
  createSourceAdmissionService,
  createWorkSourceService,
  hashWorkSourceContent,
  RECAP_QUIET_PERIOD_MS,
  workSourceModelExcerpt,
} from "../src/application"
import {
  ActorIDSchema,
  ChangeCursorSchema,
  CommandSuccessSchema,
  ContentHashSchema,
  OwnerUserIDSchema,
  RequestIDSchema,
  WorkSourceRevisionRefSchema,
} from "../src/contracts"
import type {
  OperationID,
  RecapID,
  StreamID,
  WorkGraphContext,
  WorkSourceDto,
  WorkSourceID,
  WorkSourceRevisionDto,
  WorkSourceRevisionID,
} from "../src/contracts"
import type { WorkSourcePort } from "../src/ports"

describe("manual Work Sources", () => {
  it("keeps immutable revisions with exact hashes and rejects stale heads", async () => {
    const port = memorySources()
    const service = createWorkSourceService(port)
    const first = await service.createManual(owner(), { operationId: id("op-1"), title: "Launch", content: "Initial plan" })
    const second = await service.reviseManual(owner(), {
      operationId: id("op-2"),
      workSourceId: first.source.id,
      expectedRevisionId: first.revision.id,
      content: "Revised plan",
    })

    expect(first.revision.contentHash).toBe(hashWorkSourceContent("Initial plan"))
    expect(second.revision).toMatchObject({ revisionNumber: 2, contentHash: hashWorkSourceContent("Revised plan") })
    expect((await service.readRevision(owner(), first.source.id, first.revision.id))?.content).toBe("Initial plan")
    await expect(service.reviseManual(owner(), {
      operationId: id("op-3"),
      workSourceId: first.source.id,
      expectedRevisionId: first.revision.id,
      content: "Stale overwrite",
    })).rejects.toThrow("source_head_conflict")
    expect(workSourceModelExcerpt("Initial plan", 7)).toEqual({ content: "Initial", truncated: true, originalCharacters: 12 })
    expect((await service.readRevision(owner(), first.source.id, first.revision.id))?.content).toBe("Initial plan")
  })
})

describe("source admission", () => {
  it("passes one exact authoring revision into strict planning and binds later revisions to a Stream", async () => {
    const requests: Array<{ operationId: string; command: Record<string, unknown> }> = []
    const adapter = createWorkGraphAuthoringAdapter({
      async execute(_context, request) {
        requests.push(request as never)
        if (request.command.type === "create_work_source" || request.command.type === "revise_work_source") {
          return CommandSuccessSchema.parse({
            ok: true,
            operationId: request.operationId,
            cursor: String(requests.length),
            value: { workSourceId: "source-1", revisionId: request.command.type === "create_work_source" ? "revision-1" : "revision-2" },
          })
        }
        return CommandSuccessSchema.parse({
          ok: true,
          operationId: request.operationId,
          cursor: String(requests.length),
          value: { proposalId: requests.length === 2 ? "proposal-1" : "proposal-2" },
        })
      },
    })
    const firstContent = "Initial document"
    const first = {
      adapterId: "claxedo_docs",
      projectId: "project-1",
      documentId: "doc-1",
      documentRevisionId: "doc-revision-1",
      documentRevisionNumber: 1,
      authoredAt: 10,
      authoredBy: owner().actor,
      contentHash: ContentHashSchema.parse(hashWorkSourceContent(firstContent)),
    }
    await expect(adapter.turnIntoWork(owner(), {
      operationId: id("docs:doc-1:1"),
      title: "Launch",
      content: firstContent,
      revision: first,
    })).resolves.toMatchObject({ ok: true, source: { workSourceId: "source-1", revisionId: "revision-1" }, proposalId: "proposal-1" })

    const secondContent = "Revised document"
    await expect(adapter.turnIntoWork(owner(), {
      operationId: id("docs:doc-1:2"),
      title: "Launch",
      content: secondContent,
      revision: {
        ...first,
        documentRevisionId: "doc-revision-2",
        documentRevisionNumber: 2,
        parentDocumentRevisionId: "doc-revision-1",
        contentHash: ContentHashSchema.parse(hashWorkSourceContent(secondContent)),
      },
      binding: { workSourceId: id("source-1"), latestRevisionId: id("revision-1") },
      targetStreamId: id("stream-1"),
    })).resolves.toMatchObject({ ok: true, source: { revisionId: "revision-2" }, proposalId: "proposal-2" })

    expect(requests.map((request) => request.command)).toEqual([
      expect.objectContaining({ type: "create_work_source", authoring: first }),
      expect.objectContaining({ type: "propose_admission", source: expect.objectContaining({ revisionId: "revision-1" }) }),
      expect.objectContaining({ type: "revise_work_source", expectedRevisionId: "revision-1", authoring: expect.objectContaining({ documentRevisionId: "doc-revision-2" }) }),
      expect.objectContaining({ type: "propose_admission", targetStreamId: "stream-1", source: expect.objectContaining({ revisionId: "revision-2" }) }),
    ])
    await expect(adapter.turnIntoWork(owner(), {
      operationId: id("docs:bad"),
      title: "Bad",
      content: "does not match",
      revision: first,
    })).rejects.toThrow("declared content hash")
    expect(requests).toHaveLength(4)
  })

  it("separates non-executable proposals from owner confirmation and preserves disposition", async () => {
    const commands: string[] = []
    const confirmationVersions: number[] = []
    const service = createSourceAdmissionService({
      execute: async (_context, request) => {
        commands.push(String(request.command.type))
        if (request.command.type === "confirm_admission") confirmationVersions.push(request.command.expectedVersion)
        if (request.command.type === "propose_admission") return CommandSuccessSchema.parse({
          ok: true,
          operationId: request.operationId,
          cursor: ChangeCursorSchema.parse(String(commands.length)),
          value: { proposalId: "proposal-1", executable: false },
        })
        if (request.command.type === "confirm_admission") return CommandSuccessSchema.parse({
          ok: true,
          operationId: request.operationId,
          cursor: ChangeCursorSchema.parse(String(commands.length)),
          value: { disposition: request.command.selection },
        })
        if (request.command.type === "dismiss_admission" || request.command.type === "reopen_admission") return CommandSuccessSchema.parse({
          ok: true,
          operationId: request.operationId,
          cursor: ChangeCursorSchema.parse(String(commands.length)),
          value: { proposalId: request.command.proposalId, version: request.command.expectedVersion + 1 },
        })
        throw new Error(`Unexpected command: ${request.command.type}`)
      },
    })
    const source = WorkSourceRevisionRefSchema.parse({
      workSourceId: "source-1",
      revisionId: "revision-1",
      contentHash: hashWorkSourceContent("Plan"),
    })
    const proposed = await service.propose(owner(), { operationId: id("op-1"), source })
    expect(proposed).toMatchObject({ ok: true, value: { executable: false } })
    expect(commands).toEqual(["propose_admission"])

    await expect(service.dismiss(owner(), {
      operationId: id("op-dismiss"),
      proposalId: id("proposal-1"),
      expectedVersion: 3,
    })).resolves.toMatchObject({ ok: true, value: { proposalId: "proposal-1", version: 4 } })
    await expect(service.reopen(owner(), {
      operationId: id("op-reopen"),
      proposalId: id("proposal-1"),
      expectedVersion: 4,
    })).resolves.toMatchObject({ ok: true, value: { proposalId: "proposal-1", version: 5 } })

    const confirmed = await service.confirm(owner(), {
      operationId: id("op-2"),
      proposalId: id("proposal-1"),
      expectedVersion: 5,
      source,
      selection: { mode: "fork", streamId: id("stream-1"), streamTitle: "Launch fork" },
    })
    expect(confirmed).toMatchObject({ ok: true, value: { disposition: { mode: "fork", streamTitle: "Launch fork" } } })
    expect(commands).toEqual(["propose_admission", "dismiss_admission", "reopen_admission", "confirm_admission"])
    expect(confirmationVersions).toEqual([5])
  })
})

describe("attention and background intake", () => {
  it("bounds matching to pinned and recent Streams", async () => {
    const service = createAttentionService({
      listActive: async () => [
        { id: id("old"), title: "Pinned", pinned: true, lastActivityAt: 1 },
        { id: id("new"), title: "Recent", pinned: false, lastActivityAt: 10 },
        { id: id("middle"), title: "Middle", pinned: false, lastActivityAt: 5 },
      ],
    })
    expect((await service.suggestStreams(owner(), 2)).map((stream) => stream.id)).toEqual(["old", "new"])
  })

  it("creates one idempotent unorganized candidate for an independent meaningful idle session", async () => {
    const keys = new Set<string>()
    const createUnorganized = vi.fn(async (_context, input: { idempotencyKey: string }) => {
      if (keys.has(input.idempotencyKey)) return "existing" as const
      keys.add(input.idempotencyKey)
      return "created" as const
    })
    const service = createSessionIntakeService({ createUnorganized })
    const session = { sessionId: "session-1", title: "Investigate launch", summary: "Found auth gap", meaningful: true, becameIdleAt: 1_000 }
    expect(await service.onIdle(owner(), session)).toBe("created")
    expect(await service.onIdle(owner(), session)).toBe("existing")
    expect(await service.onIdle(owner(), { ...session, sessionId: "noise", meaningful: false })).toBe("ignored")
    expect(createUnorganized).toHaveBeenCalledTimes(2)
    expect(createUnorganized.mock.calls[0]?.[1]).toMatchObject({ idempotencyKey: "idle-session:session-1", body: "Found auth gap" })
  })
})

describe("quiet-period Recaps", () => {
  it("creates one durable incremental job after eight quiet hours and resets on activity", async () => {
    const jobs = new Map<string, unknown>()
    const candidates = [
      { streamId: id<StreamID>("due"), lastActivityAt: 1_000, latestSequence: 8, lastRecap: { id: id<RecapID>("recap-1"), toSequence: 5 } },
      { streamId: id<StreamID>("active"), lastActivityAt: 1_000 + RECAP_QUIET_PERIOD_MS - 1, latestSequence: 4 },
      { streamId: id<StreamID>("unchanged"), lastActivityAt: 1_000, latestSequence: 5, lastRecap: { id: id<RecapID>("recap-2"), toSequence: 5 } },
    ]
    const service = createRecapService({
      listCandidates: async () => candidates,
      enqueue: async (_context, job) => {
        const key = `${job.streamId}:${job.toSequence}`
        if (jobs.has(key)) return "existing"
        jobs.set(key, job)
        return "created"
      },
      complete: async () => {},
    }, { now: () => 1_000 + RECAP_QUIET_PERIOD_MS })

    expect(await service.scheduleDue(owner())).toBe(1)
    expect(await service.scheduleDue(owner())).toBe(0)
    expect([...jobs.values()]).toEqual([expect.objectContaining({ streamId: "due", previousRecapId: "recap-1", fromSequence: 6, toSequence: 8, quietSince: 1_000 })])
  })
})

function memorySources(): WorkSourcePort {
  const sources = new Map<string, WorkSourceDto>()
  const revisions = new Map<string, WorkSourceRevisionDto>()
  let next = 0
  const write = (context: WorkGraphContext, input: { title: string; content: string }, source?: WorkSourceDto) => {
    const now = ++next
    const workSourceId = source?.id ?? id<WorkSourceID>(`source-${next}`)
    const revisionId = id<WorkSourceRevisionID>(`revision-${next}`)
    const revision: WorkSourceRevisionDto = {
      id: revisionId,
      workSourceId,
      revisionNumber: (source?.revisionCount ?? 0) + 1,
      content: input.content,
      contentHash: ContentHashSchema.parse(hashWorkSourceContent(input.content)),
      origin: { kind: "manual" as const },
      createdAt: now,
      createdBy: context.actor,
    }
    const record: WorkSourceDto = {
      id: workSourceId,
      ownerUserId: context.ownerUserId,
      title: input.title,
      latestRevisionId: revisionId,
      revisionCount: revision.revisionNumber,
      createdAt: source?.createdAt ?? now,
      updatedAt: now,
    }
    sources.set(workSourceId, record)
    revisions.set(`${workSourceId}:${revisionId}`, revision)
    return { source: record, revision }
  }
  return {
    createManual: async (context, input) => write(context, input),
    reviseManual: async (context, input) => {
      const source = sources.get(input.workSourceId)
      if (!source) throw new Error("source_not_found")
      if (source.latestRevisionId !== input.expectedRevisionId) throw new Error("source_head_conflict")
      return write(context, { title: input.title ?? source.title, content: input.content }, source)
    },
    readSource: async (_context, input) => sources.get(input.workSourceId),
    readRevision: async (_context, input) => revisions.get(`${input.workSourceId}:${input.revisionId}`),
  }
}

function owner(): WorkGraphContext {
  return {
    organizationId: "organization" as never,
    ownerUserId: OwnerUserIDSchema.parse("owner"),
    actor: { type: "user", id: ActorIDSchema.parse("owner") },
    requestId: RequestIDSchema.parse("request"),
    access: { mode: "owner" },
  }
}

function id<Type = string>(value: string) { return value as Type }
