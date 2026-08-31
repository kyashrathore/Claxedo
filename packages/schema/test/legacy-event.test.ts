import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { LegacyEvent } from "../src/legacy-event"
import { PermissionV1 } from "../src/permission-v1"
import { QuestionV1 } from "../src/question-v1"
import { Project } from "../src/project"
import { SessionV1 } from "../src/session-v1"

describe("legacy public event schemas", () => {
  test("user messages carry only the optional display-safe Claxedo author extension", () => {
    const unsigned = {
      id: "msg_1",
      sessionID: "ses_1",
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-4o" },
    }
    const signed = {
      ...unsigned,
      claxedo: {
        author: {
          id: "user_public_123",
          name: "Yash",
          avatarUrl: "https://example.invalid/avatar",
          kind: "human",
        },
      },
    }

    const decodedUnsigned = Schema.decodeUnknownSync(SessionV1.User)(unsigned as unknown)
    expect(decodedUnsigned as unknown).toEqual(unsigned)
    expect(Schema.decodeUnknownSync(SessionV1.User)({
      ...signed,
      claxedo: {
        author: {
          ...signed.claxedo.author,
          actorId: "internal_actor_123",
          subject: "clerk|secret",
        },
      },
    } as unknown) as unknown).toEqual(signed)
    expect(Schema.encodeSync(SessionV1.User)(decodedUnsigned) as unknown).toEqual(unsigned)
  })

  test("owns all SessionV1 definitions", () => {
    expect(SessionV1.Event.Definitions.map((event) => event.type)).toEqual([
      "session.created",
      "session.updated",
      "session.deleted",
      "message.updated",
      "message.removed",
      "message.part.updated",
      "message.part.removed",
      "message.part.delta",
      "session.diff",
      "session.error",
    ])
    const durable = SessionV1.Event.Definitions.filter((event) => event.durable !== undefined)
    expect(durable).toHaveLength(7)
    expect(durable.every((event) => event.durable?.aggregate === "sessionID")).toBe(true)
    expect(durable.every((event) => event.durable?.version === 1)).toBe(true)
  })

  test("owns the legacy transient public definitions", () => {
    expect([
      SessionV1.PartDelta.type,
      SessionV1.Diff.type,
      SessionV1.Error.type,
      PermissionV1.Event.Asked.type,
      PermissionV1.Event.Replied.type,
      QuestionV1.Event.Asked.type,
      QuestionV1.Event.Replied.type,
      QuestionV1.Event.Rejected.type,
      Project.Event.Updated.type,
      LegacyEvent.CommandExecuted.type,
    ]).toEqual([
      "message.part.delta",
      "session.diff",
      "session.error",
      "permission.asked",
      "permission.replied",
      "question.asked",
      "question.replied",
      "question.rejected",
      "project.updated",
      "command.executed",
    ])
  })
})
