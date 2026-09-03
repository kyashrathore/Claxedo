import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import {
  LATEST_SURFACE_MAX_INFO_BYTES,
  LATEST_SURFACE_MAX_OPTIONAL_INFO_VALUE_BYTES,
  LATEST_SURFACE_MAX_TEXT_BYTES,
  LATEST_SURFACE_MAX_TEXT_PART_BYTES,
  LATEST_SURFACE_MAX_TEXT_PARTS,
  latestSurfaceJSONBytes,
} from "@opencode-ai/schema/session-message-surface"
import { DateTime, Effect, Layer, Schema } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { eq } from "drizzle-orm"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"

import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(Layer.mergeAll(LayerNode.compile(LayerNode.group([SessionNs.node, Database.node])), httpApiLayer))

const model = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test"),
}
const v2Model = { providerID: model.providerID, id: model.modelID }
const encodeV2Message = Schema.encodeSync(SessionMessage.Message)
type SessionMessageInsert = typeof SessionMessageTable.$inferInsert

function v2MessageRow(sessionID: SessionID, seq: number, message: SessionMessage.Message): SessionMessageInsert {
  const { id: _, type, ...data } = encodeV2Message(message)
  return {
    id: message.id,
    session_id: sessionID,
    type,
    seq,
    time_created: DateTime.toEpochMillis(message.time.created),
    data: data as SessionMessageInsert["data"],
  }
}

afterEach(async () => {
  await disposeAllInstances()
})

const withoutWatcher = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  if (process.platform !== "win32") return effect
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER
      process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = "true"
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER
        else process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = previous
      }),
  )
}

const withoutDecodingMarker = <A, E, R>(marker: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const original = JSON.parse
      JSON.parse = ((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
        if (text.includes(marker)) throw new Error("latest-surface decoded an omitted JSON payload")
        return original(text, reviver)
      }) as typeof JSON.parse
      return original
    }),
    () => effect,
    (original) =>
      Effect.sync(() => {
        JSON.parse = original
      }),
  )

const sessionScoped = Effect.acquireRelease(SessionNs.use.create({}), (session) =>
  SessionNs.use.remove(session.id).pipe(Effect.ignore),
)

const fill = Effect.fn("SessionMessagesTest.fill")(function* (
  sessionID: SessionID,
  count: number,
  time = (i: number) => Date.now() + i,
) {
  const session = yield* SessionNs.Service
  return yield* Effect.forEach(
    Array.from({ length: count }, (_, i) => i),
    (i) =>
      Effect.gen(function* () {
        const id = MessageID.ascending()
        yield* session.updateMessage({
          id,
          sessionID,
          role: "user",
          time: { created: time(i) },
          agent: "test",
          model,
          tools: {},
        } satisfies SessionV1.User)
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: id,
          type: "text",
          text: `m${i}`,
        } satisfies SessionV1.TextPart)
        return id
      }),
  )
})

const addTurn = Effect.fn("SessionMessagesTest.addTurn")(function* (sessionID: SessionID, omittedPayload: string) {
  const session = yield* SessionNs.Service
  const user = MessageID.ascending()
  yield* session.updateMessage({
    id: user,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "test",
    model,
    summary: { body: omittedPayload, diffs: [] },
    system: omittedPayload,
    tools: { read: true },
  } satisfies SessionV1.User)
  yield* session.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID: user,
    type: "text",
    text: "latest prompt",
  } satisfies SessionV1.TextPart)

  const assistants = [] as MessageID[]
  for (const text of ["first response", "second response"]) {
    const id = MessageID.ascending()
    assistants.push(id)
    yield* session.updateMessage({
      id,
      sessionID,
      role: "assistant",
      time: { created: Date.now() },
      parentID: user,
      modelID: model.modelID,
      providerID: model.providerID,
      mode: "",
      agent: "default",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    } satisfies SessionV1.Assistant)
    yield* session.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: id,
      type: "text",
      text,
    } satisfies SessionV1.TextPart)
  }
  return { user, assistants }
})

function request(path: string) {
  return TestInstance.pipe(Effect.flatMap((test) => requestInDirectory(path, test.directory)))
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  return response.json.pipe(Effect.map((body) => body as T))
}

describe("session messages endpoint", () => {
  it.instance(
    "returns the complete latest user turn with a cursor for older history",
    withoutWatcher(
      Effect.gen(function* () {
        const omittedDecodeMarker = "LATEST_SURFACE_OMITTED_PAYLOAD_MUST_NOT_BE_PARSED"
        const omittedPayload = `${omittedDecodeMarker}:${"x".repeat(256 * 1024)}`
        const session = yield* sessionScoped
        const [older] = yield* fill(session.id, 1)
        const turn = yield* addTurn(session.id, omittedPayload)

        const latest = yield* request(`/session/${session.id}/message?view=latest-turn`)
        expect(latest.status).toBe(200)
        const body = yield* json<SessionV1.WithParts[]>(latest)
        expect(body.map((item) => item.info.id)).toEqual([turn.user, ...turn.assistants])
        expect(body.map((item) => item.parts.length)).toEqual([1, 1, 1])

        const cursor = latest.headers["x-next-cursor"]
        expect(cursor).toBeTruthy()
        expect(MessageV2.cursor.decode(cursor!).id).toBe(turn.user)
        expect(latest.headers["link"]).toContain("limit=80")
        expect(latest.headers["link"]).not.toContain("view=latest-turn")

        const previous = yield* request(`/session/${session.id}/message?limit=80&before=${encodeURIComponent(cursor!)}`)
        expect(previous.status).toBe(200)
        const previousBody = yield* json<SessionV1.WithParts[]>(previous)
        expect(previousBody.map((item) => item.info.id)).toEqual([older])

        const finalAssistant = turn.assistants.at(-1)!
        const sessionService = yield* SessionNs.Service
        yield* sessionService.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: turn.user,
          type: "file",
          mime: "text/plain",
          filename: "deferred.txt",
          url: "data:text/plain,large",
        } satisfies SessionV1.FilePart)
        yield* sessionService.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: finalAssistant,
          type: "reasoning",
          text: omittedPayload,
          time: { start: Date.now(), end: Date.now() },
        } satisfies SessionV1.ReasoningPart)

        const surface = yield* withoutDecodingMarker(
          omittedDecodeMarker,
          request(`/session/${session.id}/message?view=latest-surface`),
        )
        expect(surface.status).toBe(200)
        const surfaceBody = yield* json<SessionV1.WithParts[]>(surface)
        expect(surfaceBody.map((item) => item.info.id)).toEqual([turn.user, finalAssistant])
        expect(surfaceBody[0]?.info).not.toHaveProperty("summary")
        expect(surfaceBody[0]?.info).not.toHaveProperty("system")
        expect(surfaceBody[0]?.info).not.toHaveProperty("tools")
        expect(surfaceBody.map((item) => item.parts.map((part) => part.type))).toEqual([["text"], ["text"]])
        const completeAfterSurface = yield* request(`/session/${session.id}/message?view=latest-turn`)
        const completeBody = yield* json<SessionV1.WithParts[]>(completeAfterSurface)
        expect(completeBody[0]?.info).toMatchObject({
          summary: { body: omittedPayload, diffs: [] },
          system: omittedPayload,
          tools: { read: true },
        })
        expect(completeBody.at(-1)?.parts.map((part) => part.type)).toEqual(["text", "reasoning"])
        const surfaceCursor = surface.headers["x-next-cursor"]
        expect(MessageV2.cursor.decode(surfaceCursor!).id).toBe(finalAssistant)
        const surfacePrevious = yield* request(
          `/session/${session.id}/message?limit=80&before=${encodeURIComponent(surfaceCursor!)}`,
        )
        expect((yield* json<SessionV1.WithParts[]>(surfacePrevious)).map((item) => item.info.id)).toEqual([
          older,
          turn.user,
          turn.assistants[0],
        ])

        const mixed = yield* request(`/session/${session.id}/message?view=latest-turn&limit=2`)
        expect(mixed.status).toBe(400)
      }),
    ),
    { git: true },
  )

  it.instance(
    "returns the complete latest turn from the Session V2 projection",
    withoutWatcher(
      Effect.gen(function* () {
        const omittedDecodeMarker = "LATEST_SURFACE_V2_OMITTED_PAYLOAD_MUST_NOT_BE_PARSED"
        const omittedPayload = `${omittedDecodeMarker}:${"x".repeat(256 * 1024)}`
        const session = yield* sessionScoped
        const now = DateTime.makeUnsafe(Date.now())
        const olderUser = SessionMessage.ID.make("msg_v2_older_user")
        const latestUser = SessionMessage.ID.make("msg_v2_latest_user")
        const latestAssistants = [
          SessionMessage.ID.make("msg_v2_latest_step"),
          SessionMessage.ID.make("msg_v2_latest_final"),
        ]
        const rows = [
          v2MessageRow(
            session.id,
            1,
            SessionMessage.User.make({
              id: olderUser,
              type: "user",
              text: "older prompt",
              files: [],
              agents: [],
              time: { created: now },
            }),
          ),
          v2MessageRow(
            session.id,
            2,
            SessionMessage.Assistant.make({
              id: SessionMessage.ID.make("msg_v2_older_assistant"),
              type: "assistant",
              agent: "build",
              model: v2Model,
              content: [],
              time: { created: now, completed: now },
            }),
          ),
          v2MessageRow(
            session.id,
            3,
            SessionMessage.User.make({
              id: latestUser,
              type: "user",
              text: "latest prompt",
              files: [{ uri: omittedPayload, mime: "text/plain" }],
              agents: [],
              time: { created: now },
            }),
          ),
          v2MessageRow(
            session.id,
            4,
            SessionMessage.Assistant.make({
              id: latestAssistants[0]!,
              type: "assistant",
              agent: "build",
              model: v2Model,
              content: [
                SessionMessage.AssistantTool.make({
                  type: "tool",
                  id: "call_v2_latest",
                  name: "application_complete_task",
                  state: SessionMessage.ToolStateCompleted.make({
                    status: "completed",
                    input: {},
                    content: [],
                    structured: {},
                  }),
                  time: { created: now, completed: now },
                }),
              ],
              finish: "tool-calls",
              time: { created: now, completed: now },
            }),
          ),
          v2MessageRow(
            session.id,
            5,
            SessionMessage.Assistant.make({
              id: latestAssistants[1]!,
              type: "assistant",
              agent: "build",
              model: v2Model,
              content: [
                SessionMessage.AssistantText.make({
                  type: "text",
                  id: "text_v2_latest",
                  text: "Completed the application Task in the real project Session.",
                }),
                SessionMessage.AssistantReasoning.make({
                  type: "reasoning",
                  id: "reasoning_v2_latest",
                  text: omittedPayload,
                  time: { created: now, completed: now },
                }),
              ],
              finish: "stop",
              time: { created: now, completed: now },
            }),
          ),
        ]
        yield* Database.Service.use(({ db }) => db.insert(SessionMessageTable).values(rows).run().pipe(Effect.orDie))

        const latest = yield* request(`/session/${session.id}/message?view=latest-turn`)
        expect(latest.status).toBe(200)
        const body = yield* json<SessionV1.WithParts[]>(latest)
        expect(body.map((item) => item.info.id)).toEqual([
          MessageID.ascending(latestUser),
          ...latestAssistants.map(MessageID.ascending),
        ])
        expect(
          body.flatMap((item) => (item.info.role === "assistant" ? [item.info.parentID] : [])),
        ).toEqual([MessageID.ascending(latestUser), MessageID.ascending(latestUser)])
        expect(body.at(-1)?.parts.map((part) => part.type)).toEqual(["text", "reasoning"])
        expect(body.at(-1)?.parts[0]).toMatchObject({
          type: "text",
          text: "Completed the application Task in the real project Session.",
        })

        const cursor = latest.headers["x-next-cursor"]
        expect(cursor).toBeTruthy()
        expect(MessageV2.cursor.decode(cursor!).id).toBe(MessageID.ascending(latestUser))
        const previous = yield* request(`/session/${session.id}/message?limit=80&before=${encodeURIComponent(cursor!)}`)
        expect(previous.status).toBe(200)
        const previousBody = yield* json<SessionV1.WithParts[]>(previous)
        expect(previousBody.map((item) => item.info.id)).toEqual([
          MessageID.ascending(olderUser),
          MessageID.ascending("msg_v2_older_assistant"),
        ])
        expect(previousBody.at(-1)?.info).toMatchObject({
          role: "assistant",
          parentID: MessageID.ascending(olderUser),
        })

        const numeric = yield* request(`/session/${session.id}/message?limit=1`)
        const numericBody = yield* json<SessionV1.WithParts[]>(numeric)
        expect(numericBody).toHaveLength(1)
        expect(numericBody[0]?.info).toMatchObject({
          id: MessageID.ascending(latestAssistants[1]!),
          role: "assistant",
          parentID: MessageID.ascending(latestUser),
        })

        const surface = yield* withoutDecodingMarker(
          omittedDecodeMarker,
          request(`/session/${session.id}/message?view=latest-surface`),
        )
        expect(surface.status).toBe(200)
        const surfaceBody = yield* json<SessionV1.WithParts[]>(surface)
        expect(surfaceBody.map((item) => item.info.id)).toEqual([
          MessageID.ascending(latestUser),
          MessageID.ascending(latestAssistants[1]!),
        ])
        expect(surfaceBody.map((item) => item.parts.map((part) => part.type))).toEqual([["text"], ["text"]])
        const surfaceCursor = surface.headers["x-next-cursor"]
        const decodedSurfaceCursor = MessageV2.cursor.decode(surfaceCursor!)
        expect(decodedSurfaceCursor.source).toBe("session-v2")
        expect(decodedSurfaceCursor.seq).toBe(5)
        const surfacePrevious = yield* request(
          `/session/${session.id}/message?limit=80&before=${encodeURIComponent(surfaceCursor!)}`,
        )
        expect((yield* json<SessionV1.WithParts[]>(surfacePrevious)).map((item) => item.info.id)).toEqual([
          MessageID.ascending(olderUser),
          MessageID.ascending("msg_v2_older_assistant"),
          MessageID.ascending(latestUser),
          MessageID.ascending(latestAssistants[0]!),
        ])
      }),
    ),
    { git: true },
  )

  it.instance(
    "uses one stable composite order for dual-populated session history",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        const legacy = yield* fill(session.id, 4, (index: number) => 10_000 + index)
        const v2Time = DateTime.makeUnsafe(1_000)
        const v2User = SessionMessage.ID.make("msg_v2_z_user")
        const v2Assistant = SessionMessage.ID.make("msg_v2_a_assistant")
        yield* Database.Service.use(({ db }) =>
          db
            .insert(SessionMessageTable)
            .values([
              v2MessageRow(
                session.id,
                1,
                SessionMessage.User.make({
                  id: v2User,
                  type: "user",
                  text: "application prompt",
                  files: [],
                  agents: [],
                  time: { created: v2Time },
                }),
              ),
              v2MessageRow(
                session.id,
                2,
                SessionMessage.Assistant.make({
                  id: v2Assistant,
                  type: "assistant",
                  agent: "build",
                  model: v2Model,
                  content: [],
                  time: { created: v2Time, completed: v2Time },
                }),
              ),
            ])
            .run()
            .pipe(Effect.orDie),
        )
        const v2 = [MessageID.ascending(v2User), MessageID.ascending(v2Assistant)]

        const latest = yield* request(`/session/${session.id}/message?view=latest-turn`)
        expect(latest.status).toBe(200)
        expect((yield* json<SessionV1.WithParts[]>(latest)).map((item) => item.info.id)).toEqual(v2)
        const latestCursor = latest.headers["x-next-cursor"]
        expect(MessageV2.cursor.decode(latestCursor!).source).toBe("session-v2")
        const previous = yield* request(
          `/session/${session.id}/message?limit=80&before=${encodeURIComponent(latestCursor!)}`,
        )
        expect((yield* json<SessionV1.WithParts[]>(previous)).map((item) => item.info.id)).toEqual(legacy)

        const first = yield* request(`/session/${session.id}/message?limit=2`)
        expect((yield* json<SessionV1.WithParts[]>(first)).map((item) => item.info.id)).toEqual(v2)
        const firstCursor = first.headers["x-next-cursor"]
        expect(MessageV2.cursor.decode(firstCursor!).source).toBe("session-v2")

        const second = yield* request(
          `/session/${session.id}/message?limit=2&before=${encodeURIComponent(firstCursor!)}`,
        )
        expect((yield* json<SessionV1.WithParts[]>(second)).map((item) => item.info.id)).toEqual(legacy.slice(2))
        const secondCursor = second.headers["x-next-cursor"]
        expect(MessageV2.cursor.decode(secondCursor!).source).toBe("legacy")

        const third = yield* request(
          `/session/${session.id}/message?limit=2&before=${encodeURIComponent(secondCursor!)}`,
        )
        expect((yield* json<SessionV1.WithParts[]>(third)).map((item) => item.info.id)).toEqual(legacy.slice(0, 2))
        expect(third.headers["x-next-cursor"]).toBeUndefined()

        const complete = yield* request(`/session/${session.id}/message`)
        expect((yield* json<SessionV1.WithParts[]>(complete)).map((item) => item.info.id)).toEqual([...legacy, ...v2])
      }),
    ),
    { git: true },
  )

  it.instance(
    "keeps assistant ownership across the legacy to Session V2 boundary",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        const [legacyUser] = yield* fill(session.id, 1, () => 1_000)
        const now = DateTime.makeUnsafe(2_000)
        const assistant = SessionMessage.ID.make("msg_v2_transition_assistant")
        yield* Database.Service.use(({ db }) =>
          db
            .insert(SessionMessageTable)
            .values(
              v2MessageRow(
                session.id,
                1,
                SessionMessage.Assistant.make({
                  id: assistant,
                  type: "assistant",
                  agent: "build",
                  model: v2Model,
                  content: [],
                  time: { created: now, completed: now },
                }),
              ),
            )
            .run()
            .pipe(Effect.orDie),
        )

        for (const path of [
          `/session/${session.id}/message?view=latest-turn`,
          `/session/${session.id}/message?view=latest-surface`,
          `/session/${session.id}/message?limit=1`,
        ]) {
          const response = yield* request(path)
          expect(response.status).toBe(200)
          const body = yield* json<SessionV1.WithParts[]>(response)
          const projectedAssistant = body.find((item) => item.info.role === "assistant")
          expect(projectedAssistant?.info).toMatchObject({
            id: MessageID.ascending(assistant),
            role: "assistant",
            parentID: legacyUser,
          })
        }

        const surface = yield* request(`/session/${session.id}/message?view=latest-surface`)
        expect(surface.headers["x-next-cursor"]).toBeUndefined()
      }),
    ),
    { git: true },
  )

  it.instance(
    "bounds legacy oversized text/errors and many small parts while latest-turn stays byte-complete",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        const service = yield* SessionNs.Service
        const user = MessageID.ascending()
        const assistant = MessageID.ascending()
        const oversizedUser = "u".repeat(LATEST_SURFACE_MAX_TEXT_PART_BYTES + 1)
        const oversizedAssistant = "a".repeat(LATEST_SURFACE_MAX_TEXT_PART_BYTES + 1)
        const errorMessage = "e".repeat(8_150)
        expect(latestSurfaceJSONBytes({ type: "unknown", message: errorMessage })).toBeLessThanOrEqual(
          LATEST_SURFACE_MAX_OPTIONAL_INFO_VALUE_BYTES,
        )
        const error = { name: "UnknownError", data: { message: errorMessage } } as const
        const chunk = "x".repeat(Math.floor(LATEST_SURFACE_MAX_TEXT_BYTES / LATEST_SURFACE_MAX_TEXT_PARTS) - 256)
        yield* service.updateMessage({
          id: user,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "test",
          model,
          tools: {},
        } satisfies SessionV1.User)
        yield* service.updateMessage({
          id: assistant,
          sessionID: session.id,
          role: "assistant",
          time: { created: Date.now(), completed: Date.now() },
          parentID: user,
          modelID: model.modelID,
          providerID: model.providerID,
          mode: "",
          agent: "default",
          path: { cwd: "/", root: "/" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          error,
        } satisfies SessionV1.Assistant)
        for (const [messageID, text] of [
          [user, oversizedUser],
          [assistant, oversizedAssistant],
        ] as const) {
          yield* service.updatePart({
            id: PartID.ascending(),
            sessionID: session.id,
            messageID,
            type: "text",
            text,
          } satisfies SessionV1.TextPart)
        }
        for (let index = 0; index < 20; index++) {
          yield* service.updatePart({
            id: PartID.ascending(),
            sessionID: session.id,
            messageID: assistant,
            type: "text",
            text: chunk,
          } satisfies SessionV1.TextPart)
        }

        const surfaceResponse = yield* request(`/session/${session.id}/message?view=latest-surface`)
        const surface = yield* json<SessionV1.WithParts[]>(surfaceResponse)
        expect(surface[0]?.parts).toEqual([])
        expect((surface[1]?.info as SessionV1.Assistant).error).toBeUndefined()
        expect(surface[1]?.parts).toHaveLength(LATEST_SURFACE_MAX_TEXT_PARTS)
        expect(surface[1]?.parts.every((part) => part.type === "text" && part.text === chunk)).toBe(true)
        expect(surfaceResponse.headers["x-next-cursor"]).toBeUndefined()

        const completeResponse = yield* request(`/session/${session.id}/message?view=latest-turn`)
        const complete = yield* json<SessionV1.WithParts[]>(completeResponse)
        expect((complete[0]?.parts[0] as SessionV1.TextPart).text).toBe(oversizedUser)
        expect((complete[1]?.parts[0] as SessionV1.TextPart).text).toBe(oversizedAssistant)
        expect((complete[1]?.info as SessionV1.Assistant).error).toEqual(error)
        expect(complete[1]?.parts).toHaveLength(21)
      }),
    ),
    { git: true },
  )

  it.instance(
    "measures the final Session V2 wire envelope after path projection",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        const now = DateTime.makeUnsafe(Date.now())
        const user = SessionMessage.ID.make("msg_v2_wire_budget_user")
        const assistant = SessionMessage.ID.make("msg_v2_wire_budget_assistant")
        const longDirectory = `/${Array.from({ length: 40 }, () => "d".repeat(20)).join("/")}`
        const agent = "a".repeat(7_300)
        const assistantMessage = SessionMessage.Assistant.make({
          id: assistant,
          type: "assistant",
          agent,
          model: v2Model,
          content: [],
          time: { created: now, completed: now },
        })
        const assistantRow = v2MessageRow(session.id, 2, assistantMessage)
        expect(latestSurfaceJSONBytes(assistantRow.data)).toBeLessThanOrEqual(LATEST_SURFACE_MAX_INFO_BYTES)
        yield* Database.Service.use(({ db }) =>
          Effect.gen(function* () {
            yield* db
              .update(SessionTable)
              .set({ directory: longDirectory })
              .where(eq(SessionTable.id, session.id))
              .run()
              .pipe(Effect.orDie)
            yield* db
              .insert(SessionMessageTable)
              .values([
                v2MessageRow(
                  session.id,
                  1,
                  SessionMessage.User.make({
                    id: user,
                    type: "user",
                    text: "prompt",
                    files: [],
                    agents: [],
                    time: { created: now },
                  }),
                ),
                assistantRow,
              ])
              .run()
              .pipe(Effect.orDie)
          }),
        )

        const surfaceResponse = yield* request(`/session/${session.id}/message?view=latest-surface`)
        expect(surfaceResponse.status).toBe(200)
        expect(yield* json<SessionV1.WithParts[]>(surfaceResponse)).toEqual([])

        const completeResponse = yield* request(`/session/${session.id}/message?view=latest-turn`)
        const complete = yield* json<SessionV1.WithParts[]>(completeResponse)
        expect((complete[1]?.info as SessionV1.Assistant).path.cwd).toBe(longDirectory)
      }),
    ),
    { git: true },
  )

  it.instance(
    "bounds Session V2 oversized text/errors and many small parts while latest-turn stays byte-complete",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        const now = DateTime.makeUnsafe(Date.now())
        const user = SessionMessage.ID.make("msg_v2_budget_user")
        const assistant = SessionMessage.ID.make("msg_v2_budget_assistant")
        const oversizedUser = "u".repeat(LATEST_SURFACE_MAX_TEXT_PART_BYTES + 1)
        const oversizedAssistant = "a".repeat(LATEST_SURFACE_MAX_TEXT_PART_BYTES + 1)
        const errorMessage = "e".repeat(8_150)
        expect(latestSurfaceJSONBytes({ type: "unknown", message: errorMessage })).toBe(8_181)
        const chunk = "x".repeat(Math.floor(LATEST_SURFACE_MAX_TEXT_BYTES / LATEST_SURFACE_MAX_TEXT_PARTS) - 256)
        const content = [
          SessionMessage.AssistantText.make({ type: "text", id: "oversized", text: oversizedAssistant }),
          ...Array.from({ length: 20 }, (_, index) =>
            SessionMessage.AssistantText.make({ type: "text", id: `small-${index}`, text: chunk })),
        ]
        yield* Database.Service.use(({ db }) =>
          db
            .insert(SessionMessageTable)
            .values([
              v2MessageRow(
                session.id,
                1,
                SessionMessage.User.make({
                  id: user,
                  type: "user",
                  text: oversizedUser,
                  files: [],
                  agents: [],
                  time: { created: now },
                }),
              ),
              v2MessageRow(
                session.id,
                2,
                SessionMessage.Assistant.make({
                  id: assistant,
                  type: "assistant",
                  agent: "build",
                  model: v2Model,
                  content,
                  error: { type: "unknown", message: errorMessage },
                  time: { created: now, completed: now },
                }),
              ),
            ])
            .run()
            .pipe(Effect.orDie),
        )

        const surfaceResponse = yield* request(`/session/${session.id}/message?view=latest-surface`)
        expect(surfaceResponse.status).toBe(200)
        const surface = yield* json<SessionV1.WithParts[]>(surfaceResponse)
        expect(surface[0]?.parts).toEqual([])
        expect((surface[1]?.info as SessionV1.Assistant).error).toBeUndefined()
        expect(surface[1]?.parts).toHaveLength(LATEST_SURFACE_MAX_TEXT_PARTS)
        expect(surface[1]?.parts.every((part) => part.type === "text" && part.text === chunk)).toBe(true)
        expect(surfaceResponse.headers["x-next-cursor"]).toBeUndefined()

        const completeResponse = yield* request(`/session/${session.id}/message?view=latest-turn`)
        const complete = yield* json<SessionV1.WithParts[]>(completeResponse)
        expect((complete[0]?.parts[0] as SessionV1.TextPart).text).toBe(oversizedUser)
        expect((complete[1]?.parts[0] as SessionV1.TextPart).text).toBe(oversizedAssistant)
        expect((complete[1]?.info as SessionV1.Assistant).error).toMatchObject({
          name: "UnknownError",
          data: { message: errorMessage },
        })
        expect(complete[1]?.parts).toHaveLength(21)
      }),
    ),
    { git: true },
  )

  it.instance(
    "does not invent surface cursors for adjacent legacy or Session V2 messages",
    withoutWatcher(
      Effect.gen(function* () {
        const legacySession = yield* sessionScoped
        const [legacyUser] = yield* fill(legacySession.id, 1)
        const legacyAssistant = MessageID.ascending()
        const sessionService = yield* SessionNs.Service
        yield* sessionService.updateMessage({
          id: legacyAssistant,
          sessionID: legacySession.id,
          role: "assistant",
          time: { created: Date.now() },
          parentID: legacyUser,
          modelID: model.modelID,
          providerID: model.providerID,
          mode: "",
          agent: "default",
          path: { cwd: "/", root: "/" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        } satisfies SessionV1.Assistant)
        const legacySurface = yield* request(`/session/${legacySession.id}/message?view=latest-surface`)
        expect(legacySurface.headers["x-next-cursor"]).toBeUndefined()

        const v2Session = yield* sessionScoped
        const now = DateTime.makeUnsafe(Date.now())
        const v2User = SessionMessage.ID.make("msg_adjacent_v2_user")
        const v2Assistant = SessionMessage.ID.make("msg_adjacent_v2_assistant")
        yield* Database.Service.use(({ db }) =>
          db
            .insert(SessionMessageTable)
            .values([
              v2MessageRow(
                v2Session.id,
                1,
                SessionMessage.User.make({
                  id: v2User,
                  type: "user",
                  text: "prompt",
                  files: [],
                  agents: [],
                  time: { created: now },
                }),
              ),
              v2MessageRow(
                v2Session.id,
                2,
                SessionMessage.Assistant.make({
                  id: v2Assistant,
                  type: "assistant",
                  agent: "build",
                  model: v2Model,
                  content: [],
                  time: { created: now, completed: now },
                }),
              ),
            ])
            .run()
            .pipe(Effect.orDie),
        )
        const v2Surface = yield* request(`/session/${v2Session.id}/message?view=latest-surface`)
        expect(v2Surface.headers["x-next-cursor"]).toBeUndefined()
      }),
    ),
    { git: true },
  )

  it.instance(
    "rejects a legacy latest turn whose assistant belongs to another user",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        const service = yield* SessionNs.Service
        const user = MessageID.ascending()
        yield* service.updateMessage({
          id: user,
          sessionID: session.id,
          role: "user",
          time: { created: 1 },
          agent: "test",
          model,
          tools: {},
        } satisfies SessionV1.User)
        yield* service.updateMessage({
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "assistant",
          time: { created: 2 },
          parentID: MessageID.ascending(),
          modelID: model.modelID,
          providerID: model.providerID,
          mode: "",
          agent: "default",
          path: { cwd: "/", root: "/" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        } satisfies SessionV1.Assistant)

        for (const view of ["latest-surface", "latest-turn"] as const) {
          const response = yield* request(`/session/${session.id}/message?view=${view}`)
          expect(response.status).toBe(400)
        }
      }),
    ),
    { git: true },
  )

  it.instance(
    "returns cursor headers for older pages",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        const ids = yield* fill(session.id, 5)

        const a = yield* request(`/session/${session.id}/message?limit=2`)
        expect(a.status).toBe(200)
        const aBody = yield* json<SessionV1.WithParts[]>(a)
        expect(aBody.map((item) => item.info.id)).toEqual(ids.slice(-2))
        const cursor = a.headers["x-next-cursor"]
        expect(cursor).toBeTruthy()
        expect(a.headers["link"]).toContain('rel="next"')

        const b = yield* request(`/session/${session.id}/message?limit=2&before=${encodeURIComponent(cursor!)}`)
        expect(b.status).toBe(200)
        const bBody = yield* json<SessionV1.WithParts[]>(b)
        expect(bBody.map((item) => item.info.id)).toEqual(ids.slice(-4, -2))
      }),
    ),
    { git: true },
  )

  it.instance(
    "keeps full-history responses when limit is omitted",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        const ids = yield* fill(session.id, 3)

        const res = yield* request(`/session/${session.id}/message`)
        expect(res.status).toBe(200)
        const body = yield* json<SessionV1.WithParts[]>(res)
        expect(body.map((item) => item.info.id)).toEqual(ids)
      }),
    ),
    { git: true },
  )

  it.instance(
    "rejects invalid cursors and missing sessions",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped

        const bad = yield* request(`/session/${session.id}/message?limit=2&before=bad`)
        expect(bad.status).toBe(400)

        const miss = yield* request(`/session/ses_missing/message?limit=2`)
        expect(miss.status).toBe(404)
      }),
    ),
    { git: true },
  )

  it.instance(
    "does not truncate large legacy limit requests",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        yield* fill(session.id, 520)

        const res = yield* request(`/session/${session.id}/message?limit=510`)
        expect(res.status).toBe(200)
        const body = yield* json<SessionV1.WithParts[]>(res)
        expect(body).toHaveLength(510)
      }),
    ),
    { git: true },
  )

  it.instance(
    "accepts directory query used by workspace routing",
    withoutWatcher(
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const session = yield* sessionScoped
        yield* fill(session.id, 1)

        const res = yield* request(
          `/session/${session.id}/message?limit=80&directory=${encodeURIComponent(tmp.directory)}`,
        )
        expect(res.status).toBe(200)
        const body = yield* json<unknown[]>(res)
        expect(Array.isArray(body)).toBe(true)
        expect(body).toHaveLength(1)
      }),
    ),
    { git: true },
  )
})
