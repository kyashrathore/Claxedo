import { describe, expect, it, vi } from "vitest"
import {
  createSessionIntakeService,
  createSourceAdmissionService,
  hashWorkSourceContent,
} from "../src/application"
import {
  ActorIDSchema,
  ChangeCursorSchema,
  CommandSuccessSchema,
  OwnerUserIDSchema,
  RequestIDSchema,
  WorkSourceRevisionRefSchema,
} from "../src/contracts"
import type { WorkGraphContext } from "../src/contracts"

describe("source admission", () => {
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
