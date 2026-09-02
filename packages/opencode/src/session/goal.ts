import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer, Schema } from "effect"
import { SessionID } from "./schema"
import { Session } from "./session"

/**
 * Where a session's durable Goal snapshot lives in session metadata.
 *
 * Exported because it is a wire contract, not an implementation detail: writing
 * it publishes `session.updated` carrying the whole session info, which is how
 * `@claxedo/agent-sdk-runtime`'s OpenCode adapter learns of every Goal
 * transition. That package mirrors this literal (it cannot import this one) and
 * `test/session/goal-protocol.test.ts` pins the two copies together.
 */
export const GOAL_METADATA_KEY = "claxedo.goal"

export const Status = Schema.Literals(["active", "paused", "blocked", "limited", "complete"])

export const Snapshot = Schema.Struct({
  sessionId: Schema.String,
  objective: Schema.String,
  status: Status,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  tokenBudget: Schema.optional(Schema.Number),
  tokensUsed: Schema.optional(Schema.Number),
  timeUsedSeconds: Schema.optional(Schema.Number),
  iteration: Schema.optional(Schema.Number),
  lastReason: Schema.optional(Schema.String),
})
export type Snapshot = Schema.Schema.Type<typeof Snapshot>

export type Run = {
  generation: number
  signal: AbortSignal
  goal: Snapshot
}

export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<Snapshot | null, Session.NotFound>
  /**
   * Every session in this instance's workspace directory whose durable Goal is
   * still `active`. This is what restart recovery reconciles against: the
   * aggregate knows which Goals were mid-flight when the process died, so
   * recovery never has to wait for a client to touch a session.
   */
  readonly pending: () => Effect.Effect<SessionID[]>
  readonly restore: (sessionID: SessionID) => Effect.Effect<Run | null, Session.NotFound>
  readonly start: (input: { sessionID: SessionID; objective: string }) => Effect.Effect<Run, Session.NotFound | Conflict>
  readonly pause: (sessionID: SessionID) => Effect.Effect<Snapshot, Session.NotFound | Missing | Conflict>
  readonly resume: (sessionID: SessionID) => Effect.Effect<Run, Session.NotFound | Missing | Conflict>
  readonly delete: (sessionID: SessionID) => Effect.Effect<void, Session.NotFound | Missing>
  readonly update: (input: {
    sessionID: SessionID
    generation: number
    update: (goal: Snapshot) => Snapshot
  }) => Effect.Effect<Snapshot | null, Session.NotFound>
  readonly canContinue: (sessionID: SessionID, generation: number) => Effect.Effect<boolean, Session.NotFound>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionGoal") {}

export class Missing extends Schema.TaggedErrorClass<Missing>()("SessionGoal.Missing", {
  sessionID: SessionID,
  message: Schema.String,
}) {}

export class Conflict extends Schema.TaggedErrorClass<Conflict>()("SessionGoal.Conflict", {
  sessionID: SessionID,
  message: Schema.String,
}) {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const controllers = new Map<SessionID, { generation: number; abort: AbortController }>()
    const generations = new Map<SessionID, number>()

    const decode = (candidate: unknown) =>
      Schema.decodeUnknownEffect(Snapshot)(candidate).pipe(Effect.orElseSucceed(() => null))

    const readStored = Effect.fn("SessionGoal.readStored")(function* (sessionID: SessionID) {
      const current = yield* sessions.get(sessionID)
      const candidate = current.metadata?.[GOAL_METADATA_KEY]
      if (!candidate) return null
      return yield* decode(candidate)
    })

    const write = Effect.fn("SessionGoal.write")(function* (sessionID: SessionID, goal: Snapshot | null) {
      const current = yield* sessions.get(sessionID)
      const metadata = { ...(current.metadata ?? {}) }
      if (goal) metadata[GOAL_METADATA_KEY] = goal
      else delete metadata[GOAL_METADATA_KEY]
      yield* sessions.setMetadata({ sessionID, metadata })
    })

    const get = Effect.fn("SessionGoal.get")(function* (sessionID: SessionID) {
      return yield* readStored(sessionID)
    })

    const pending = Effect.fn("SessionGoal.pending")(function* () {
      const rows = yield* sessions.listByMetadataKey(GOAL_METADATA_KEY)
      const ids: SessionID[] = []
      for (const row of rows) {
        const candidate = row.metadata?.[GOAL_METADATA_KEY]
        if (!candidate) continue
        const goal = yield* decode(candidate)
        if (goal?.status === "active") ids.push(row.id)
      }
      return ids
    })

    const install = (sessionID: SessionID) => {
      const generation = (generations.get(sessionID) ?? 0) + 1
      generations.set(sessionID, generation)
      const abort = new AbortController()
      controllers.set(sessionID, { generation, abort })
      return { generation, signal: abort.signal }
    }

    const restore = Effect.fn("SessionGoal.restore")(function* (sessionID: SessionID) {
      const goal = yield* readStored(sessionID)
      if (!goal || goal.status !== "active" || controllers.has(sessionID)) return null
      return { ...install(sessionID), goal }
    })

    const start = Effect.fn("SessionGoal.start")(function* (input: { sessionID: SessionID; objective: string }) {
      const existing = yield* readStored(input.sessionID)
      if (existing) {
        return yield* new Conflict({
          sessionID: input.sessionID,
          message: "A Goal already exists for this session",
        })
      }
      const controller = install(input.sessionID)
      const now = Date.now()
      const goal: Snapshot = {
        sessionId: input.sessionID,
        objective: input.objective,
        status: "active",
        createdAt: now,
        updatedAt: now,
        iteration: 0,
      }
      yield* write(input.sessionID, goal)
      return { ...controller, goal }
    })

    const pause = Effect.fn("SessionGoal.pause")(function* (sessionID: SessionID) {
      const current = yield* readStored(sessionID)
      if (!current) return yield* new Missing({ sessionID, message: "No Goal exists" })
      if (current.status === "complete") {
        return yield* new Conflict({ sessionID, message: "A completed Goal cannot be paused" })
      }
      const paused: Snapshot = {
        ...current,
        status: "paused",
        updatedAt: Date.now(),
        lastReason: "Paused",
      }
      // Durable state changes before cancellation so a finishing work turn can
      // never observe active and enqueue another continuation.
      yield* write(sessionID, paused)
      controllers.get(sessionID)?.abort.abort()
      controllers.delete(sessionID)
      return paused
    })

    const resume = Effect.fn("SessionGoal.resume")(function* (sessionID: SessionID) {
      const current = yield* readStored(sessionID)
      if (!current) return yield* new Missing({ sessionID, message: "No Goal exists" })
      if (current.status !== "paused" && current.status !== "blocked") {
        return yield* new Conflict({ sessionID, message: `Goal is ${current.status}, not paused` })
      }
      const controller = install(sessionID)
      const goal: Snapshot = {
        ...current,
        status: "active",
        updatedAt: Date.now(),
        lastReason: "Resumed",
      }
      yield* write(sessionID, goal)
      return { ...controller, goal }
    })

    const remove = Effect.fn("SessionGoal.delete")(function* (sessionID: SessionID) {
      const current = yield* readStored(sessionID)
      if (!current) return yield* new Missing({ sessionID, message: "No Goal exists" })
      yield* write(sessionID, null)
      controllers.get(sessionID)?.abort.abort()
      controllers.delete(sessionID)
    })

    const update = Effect.fn("SessionGoal.update")(function* (input: {
      sessionID: SessionID
      generation: number
      update: (goal: Snapshot) => Snapshot
    }) {
      const controller = controllers.get(input.sessionID)
      const current = yield* readStored(input.sessionID)
      if (!current || current.status !== "active" || controller?.generation !== input.generation) return null
      const next = input.update(current)
      yield* write(input.sessionID, next)
      if (next.status !== "active") controllers.delete(input.sessionID)
      return next
    })

    const canContinue = Effect.fn("SessionGoal.canContinue")(function* (sessionID: SessionID, generation: number) {
      const current = yield* readStored(sessionID)
      return current?.status === "active" && controllers.get(sessionID)?.generation === generation
    })

    return Service.of({ get, pending, restore, start, pause, resume, delete: remove, update, canContinue })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Session.node] })

export * as SessionGoal from "./goal"
