import { describe, expect } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { SessionGoal } from "../../src/session/goal"
import { Session } from "../../src/session/session"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { EventV2Bridge } from "@/event-v2-bridge"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionGoal.node,
      Session.node,
      SessionProjector.node,
      EventV2Bridge.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

describe("OpenCode session Goal aggregate", () => {
  it.instance("persists owned Pause, Resume, completion, and Delete transitions", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const goals = yield* SessionGoal.Service
      const session = yield* sessions.create({ title: "Goal lifecycle" })

      const run = yield* goals.start({ sessionID: session.id, objective: "Ship verified work" })
      expect(run.goal).toMatchObject({ status: "active", iteration: 0 })
      expect(yield* goals.canContinue(session.id, run.generation)).toBe(true)

      const first = yield* goals.update({
        sessionID: session.id,
        generation: run.generation,
        update: (goal) => ({ ...goal, iteration: 1, updatedAt: Date.now(), lastReason: "Missing tests" }),
      })
      expect(first).toMatchObject({ status: "active", iteration: 1, lastReason: "Missing tests" })

      const paused = yield* goals.pause(session.id)
      expect(paused.status).toBe("paused")
      expect(yield* goals.canContinue(session.id, run.generation)).toBe(false)
      expect(yield* goals.update({
        sessionID: session.id,
        generation: run.generation,
        update: (goal) => ({ ...goal, status: "complete", updatedAt: Date.now() }),
      })).toBeNull()

      const resumed = yield* goals.resume(session.id)
      expect(resumed.goal).toMatchObject({ status: "active", objective: "Ship verified work", iteration: 1 })
      const complete = yield* goals.update({
        sessionID: session.id,
        generation: resumed.generation,
        update: (goal) => ({
          ...goal,
          status: "complete",
          iteration: 2,
          updatedAt: Date.now(),
          lastReason: "Tests pass",
        }),
      })
      expect(complete).toMatchObject({ status: "complete", iteration: 2, lastReason: "Tests pass" })

      yield* goals.delete(session.id)
      expect(yield* goals.get(session.id)).toBeNull()
    }),
  )

  it.instance("restores a durable active Goal with a new execution controller", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const goals = yield* SessionGoal.Service
      const session = yield* sessions.create({
        title: "Recovered Goal",
        metadata: {
          "claxedo.goal": {
            sessionId: "placeholder",
            objective: "Recover honestly",
            status: "active",
            createdAt: 1,
            updatedAt: 1,
            iteration: 3,
          },
        },
      })
      yield* sessions.setMetadata({
        sessionID: session.id,
        metadata: {
          "claxedo.goal": {
            sessionId: session.id,
            objective: "Recover honestly",
            status: "active",
            createdAt: 1,
            updatedAt: 1,
            iteration: 3,
          },
        },
      })

      const restored = yield* goals.restore(session.id)
      expect(restored?.goal).toMatchObject({
        objective: "Recover honestly",
        status: "active",
        iteration: 3,
      })
      expect(yield* goals.canContinue(session.id, restored!.generation)).toBe(true)
      expect(yield* goals.restore(session.id)).toBeNull()
    }),
  )

  it.instance("reports only sessions whose durable Goal is still active", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const goals = yield* SessionGoal.Service
      const active = yield* sessions.create({ title: "Active Goal" })
      const paused = yield* sessions.create({ title: "Paused Goal" })
      const none = yield* sessions.create({ title: "No Goal" })

      yield* goals.start({ sessionID: active.id, objective: "Keep going" })
      yield* goals.start({ sessionID: paused.id, objective: "Stop here" })
      yield* goals.pause(paused.id)

      const ids = yield* goals.pending()
      expect(ids).toContain(active.id)
      expect(ids).not.toContain(paused.id)
      expect(ids).not.toContain(none.id)
    }),
  )

  it.instance("requires explicit deletion before replacing a completed Goal", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const goals = yield* SessionGoal.Service
      const session = yield* sessions.create({ title: "Completed Goal" })
      const run = yield* goals.start({ sessionID: session.id, objective: "First Goal" })
      yield* goals.update({
        sessionID: session.id,
        generation: run.generation,
        update: (goal) => ({ ...goal, status: "complete", updatedAt: Date.now() }),
      })

      const replacement = yield* Effect.flip(goals.start({ sessionID: session.id, objective: "Replacement" }))
      expect(replacement).toBeInstanceOf(SessionGoal.Conflict)
      expect(yield* goals.get(session.id)).toMatchObject({ objective: "First Goal", status: "complete" })
    }),
  )
})
