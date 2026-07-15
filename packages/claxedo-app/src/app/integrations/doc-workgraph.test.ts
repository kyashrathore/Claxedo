import { describe, expect, test } from "bun:test"
import { hash } from "@/lib/encode"
import { createWorkGraphClient } from "@/features/workgraph/api"
import { createDocsApi } from "@/features/documents/data/docs-api"
import { createDocumentWorkGraphHandoff, createTurnDocumentRevisionIntoWork } from "./doc-workgraph"

const actor = { type: "user" as const, id: "user_1" }

describe("Docs v2 WorkGraph handoff", () => {
  test("loads the selected durable Docs revision before creating its Work Source and proposal", async () => {
    const markdown = "# Exact durable revision"
    const contentHash = await hash(markdown)
    const calls: string[] = []
    const request = async (requestInput: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(requestInput)
      calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`)
      if (url.pathname.startsWith("/api/claxedo/docs/")) {
        return Response.json({
          projectId: "project_1",
          documentId: "document_1",
          documentTitle: "Exact durable revision",
          revisionId: "document_revision_1",
          revisionNumber: 1,
          markdown,
          contentHash,
          authoredAt: 100,
          authoredBy: actor,
        })
      }
      if (url.pathname.endsWith("/sources")) return Response.json({ sources: [], hasMore: false })
      const body = JSON.parse(String(init?.body)) as { operationId: string; command: { type: string } }
      if (body.command.type === "create_work_source") {
        return success(body.operationId, { workSourceId: "source_1", revisionId: "source_revision_1" })
      }
      return success(body.operationId, { proposalId: "proposal_1", state: "planning" })
    }
    const docs = createDocsApi({ baseUrl: "https://control.test", request })
    const turnIntoWork = createTurnDocumentRevisionIntoWork({
      readRevision: docs.revisionForWork,
      handoff: createDocumentWorkGraphHandoff({
        client: createWorkGraphClient({ baseUrl: "https://control.test", request }),
      }),
    })

    await expect(turnIntoWork({
      projectId: "project_1",
      documentId: "document_1",
      revisionId: "document_revision_1",
    })).resolves.toMatchObject({ proposalId: "proposal_1" })
    expect(calls).toEqual([
      "GET /api/claxedo/docs/document_1/revisions/document_revision_1?project_id=project_1",
      "GET /api/workgraph/sources?limit=100",
      "POST /api/workgraph/commands",
      "POST /api/workgraph/commands",
    ])
  })

  test("sends one exact first revision with its hash and provenance into strict planning", async () => {
    const markdown = "# Launch\n\nShip the cloud."
    const revision = await documentRevision({ markdown, contentHash: await hash(markdown) })
    const commands: Array<Record<string, unknown>> = []
    const operationIds: string[] = []
    const request = async (requestInput: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(requestInput)
      if (url.pathname.endsWith("/sources")) return Response.json({ sources: [], hasMore: false })
      const body = JSON.parse(String(init?.body)) as { operationId: string; command: Record<string, unknown> }
      operationIds.push(body.operationId)
      commands.push(body.command)
      if (body.command.type === "create_work_source") {
        return success(body.operationId, { workSourceId: "source_1", revisionId: "source_revision_1" })
      }
      return success(body.operationId, { proposalId: "proposal_1", state: "planning" })
    }

    const result = await createDocumentWorkGraphHandoff({
      client: createWorkGraphClient({ baseUrl: "https://control.test", request }),
    })(revision)

    expect(result).toEqual({
      proposalId: "proposal_1",
      source: { workSourceId: "source_1", revisionId: "source_revision_1", contentHash: revision.contentHash },
    })
    expect(commands).toEqual([
      {
        version: 1,
        type: "create_work_source",
        title: "Launch Claxedo",
        content: markdown,
        authoring: {
          adapterId: "claxedo_docs",
          projectId: "project_1",
          documentId: "document_1",
          documentRevisionId: "document_revision_1",
          documentRevisionNumber: 1,
          authoredAt: 100,
          authoredBy: actor,
          contentHash: revision.contentHash,
        },
      },
      {
        version: 1,
        type: "propose_admission",
        source: { workSourceId: "source_1", revisionId: "source_revision_1", contentHash: revision.contentHash },
      },
    ])
    expect(operationIds).toHaveLength(2)
    expect(new Set(operationIds).size).toBe(2)
    expect(operationIds.every((id) => /^docs:[a-f0-9]{64}$/.test(id))).toBe(true)
  })

  test("appends a direct child revision to the same source and targets its one confirmed Stream", async () => {
    const previousMarkdown = "# Launch"
    const markdown = "# Launch\n\nAdd rollout checks."
    const previousHash = await hash(previousMarkdown)
    const revision = await documentRevision({
      markdown,
      contentHash: await hash(markdown),
      revisionId: "document_revision_2",
      revisionNumber: 2,
      parentRevisionId: "document_revision_1",
      authoredAt: 200,
      authoredBy: { type: "agent", id: "agent_1" },
    })
    const commands: Array<Record<string, unknown>> = []
    const request = async (requestInput: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(requestInput)
      if (url.pathname.endsWith("/sources")) return Response.json({ sources: [workSource("source_1", "source_revision_1")], hasMore: false })
      if (url.pathname.endsWith("/sources/source_1/revisions/source_revision_1")) {
        return Response.json(workSourceRevision({ content: previousMarkdown, contentHash: previousHash }))
      }
      if (url.pathname.endsWith("/snapshot")) return Response.json(snapshot(previousHash))
      const body = JSON.parse(String(init?.body)) as { operationId: string; command: Record<string, unknown> }
      commands.push(body.command)
      if (body.command.type === "revise_work_source") {
        return success(body.operationId, { workSourceId: "source_1", revisionId: "source_revision_2" })
      }
      return success(body.operationId, { proposalId: "proposal_2", state: "planning" })
    }

    const result = await createDocumentWorkGraphHandoff({
      client: createWorkGraphClient({ baseUrl: "https://control.test", request }),
    })(revision)

    expect(result).toEqual({
      proposalId: "proposal_2",
      source: { workSourceId: "source_1", revisionId: "source_revision_2", contentHash: revision.contentHash },
      targetStreamId: "stream_1",
    })
    expect(commands).toEqual([
      expect.objectContaining({
        type: "revise_work_source",
        workSourceId: "source_1",
        expectedRevisionId: "source_revision_1",
        content: markdown,
        authoring: expect.objectContaining({
          documentRevisionId: "document_revision_2",
          parentDocumentRevisionId: "document_revision_1",
          authoredBy: { type: "agent", id: "agent_1" },
          contentHash: revision.contentHash,
        }),
      }),
      {
        version: 1,
        type: "propose_admission",
        source: { workSourceId: "source_1", revisionId: "source_revision_2", contentHash: revision.contentHash },
        targetStreamId: "stream_1",
      },
    ])
  })

  test("rejects a changed payload for an immutable revision before any WorkGraph request", async () => {
    let requests = 0
    const handoff = createDocumentWorkGraphHandoff({
      client: createWorkGraphClient({
        baseUrl: "https://control.test",
        request: async () => {
          requests++
          return Response.json({})
        },
      }),
    })

    await expect(handoff(await documentRevision({ contentHash: "0".repeat(64) }))).rejects.toMatchObject({
      name: "DocumentWorkGraphHandoffError",
      code: "content_hash_mismatch",
      stage: "revision",
    })
    expect(requests).toBe(0)
  })

  test("surfaces strict planner rejection and creates no substitute Tasks", async () => {
    const revision = await documentRevision()
    const commandTypes: string[] = []
    const request = async (requestInput: string | URL | Request, init?: RequestInit) => {
      if (requestUrl(requestInput).pathname.endsWith("/sources")) return Response.json({ sources: [], hasMore: false })
      const body = JSON.parse(String(init?.body)) as { operationId: string; command: { type: string } }
      commandTypes.push(body.command.type)
      if (body.command.type === "create_work_source") {
        return success(body.operationId, { workSourceId: "source_1", revisionId: "source_revision_1" })
      }
      return Response.json({
        ok: false,
        operationId: body.operationId,
        error: { code: "execution_unavailable", message: "Planner configuration is unavailable", retryable: true },
      })
    }

    await expect(createDocumentWorkGraphHandoff({
      client: createWorkGraphClient({ baseUrl: "https://control.test", request }),
    })(revision)).rejects.toMatchObject({
      name: "DocumentWorkGraphHandoffError",
      code: "command_rejected",
      stage: "planning",
      result: { error: { code: "execution_unavailable", retryable: true } },
    })
    expect(commandTypes).toEqual(["create_work_source", "propose_admission"])
    expect(commandTypes).not.toContain("create_stream")
    expect(commandTypes).not.toContain("create_work_item")
  })

  test("requires an explicit target when one Docs source belongs to multiple Streams", async () => {
    const previousMarkdown = "# Launch"
    const previousHash = await hash(previousMarkdown)
    const markdown = "# Launch\n\nNext revision"
    const revision = await documentRevision({
      markdown,
      contentHash: await hash(markdown),
      revisionId: "document_revision_2",
      revisionNumber: 2,
      parentRevisionId: "document_revision_1",
    })
    let commands = 0
    const request = async (requestInput: string | URL | Request) => {
      const url = requestUrl(requestInput)
      if (url.pathname.endsWith("/sources")) return Response.json({ sources: [workSource("source_1", "source_revision_1")], hasMore: false })
      if (url.pathname.endsWith("/sources/source_1/revisions/source_revision_1")) {
        return Response.json(workSourceRevision({ content: previousMarkdown, contentHash: previousHash }))
      }
      if (url.pathname.endsWith("/snapshot")) {
        const value = snapshot(previousHash)
        return Response.json({
          ...value,
          records: [value.records[0], { ...value.records[0], id: "stream_2", title: "Second Stream" }],
          references: [
            value.references[0],
            { sequence: 2, resource: { type: "stream", id: "stream_2" }, version: 1 },
          ],
        })
      }
      commands++
      return Response.json({})
    }

    await expect(createDocumentWorkGraphHandoff({
      client: createWorkGraphClient({ baseUrl: "https://control.test", request }),
    })(revision)).rejects.toEqual(expect.objectContaining({
      name: "DocumentWorkGraphHandoffError",
      code: "target_stream_required",
      stage: "placement",
    }))
    expect(commands).toBe(0)
  })
})

async function documentRevision(overrides: Partial<{
  markdown: string
  contentHash: string
  revisionId: string
  revisionNumber: number
  parentRevisionId: string
  authoredAt: number
  authoredBy: { type: "user" | "agent" | "system"; id: string }
}> = {}) {
  const markdown = overrides.markdown ?? "# Launch"
  return {
    projectId: "project_1",
    documentId: "document_1",
    documentTitle: "Launch Claxedo",
    revisionId: overrides.revisionId ?? "document_revision_1",
    revisionNumber: overrides.revisionNumber ?? 1,
    ...(overrides.parentRevisionId ? { parentRevisionId: overrides.parentRevisionId } : {}),
    markdown,
    contentHash: overrides.contentHash ?? await hash(markdown),
    authoredAt: overrides.authoredAt ?? 100,
    authoredBy: overrides.authoredBy ?? actor,
  }
}

function requestUrl(input: string | URL | Request) {
  return new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url)
}

function success(operationId: string, value: Record<string, unknown>) {
  return Response.json({ ok: true, operationId, cursor: `cursor_${operationId}`, value })
}

function workSource(id: string, latestRevisionId: string) {
  return {
    id,
    ownerUserId: "user_1",
    title: "Launch Claxedo",
    latestRevisionId,
    revisionCount: 1,
    createdAt: 100,
    updatedAt: 100,
  }
}

function workSourceRevision(input: { content: string; contentHash: string }) {
  return {
    id: "source_revision_1",
    workSourceId: "source_1",
    revisionNumber: 1,
    content: input.content,
    contentHash: input.contentHash,
    origin: {
      kind: "authoring",
      adapterId: "claxedo_docs",
      projectId: "project_1",
      documentId: "document_1",
      documentRevisionId: "document_revision_1",
      documentRevisionNumber: 1,
      authoredAt: 100,
      authoredBy: actor,
      contentHash: input.contentHash,
    },
    createdAt: 100,
    createdBy: actor,
  }
}

function snapshot(contentHash: string) {
  const stream = {
    recordType: "stream",
    schemaVersion: 1,
    ownerUserId: "user_1",
    version: 1,
    createdAt: 100,
    updatedAt: 100,
    provenance: { actor },
    id: "stream_1",
    title: "Launch Claxedo",
    lifecycleState: "active",
    visibility: "visible",
    pinned: false,
    executionDefaults: {},
    recapDefaults: {},
    activity: { lastActivityAt: 100, recapDueAt: 200 },
    durableEffectCount: 0,
    sourceRevisionRefs: [{ workSourceId: "source_1", revisionId: "source_revision_1", contentHash }],
  }
  return {
    snapshotCursor: "cursor_1",
    records: [stream],
    references: [{ sequence: 1, resource: { type: "stream", id: "stream_1" }, version: 1 }],
    hasMore: false,
    capturedAt: 200,
  }
}
