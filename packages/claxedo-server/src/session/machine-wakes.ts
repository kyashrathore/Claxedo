import { Hono } from "hono"
import { createScheduler, createWakes, handleWakeToolCall, type WakeStore } from "@claxedo/wakes"
import { controlPlaneAuthContext, ControlPlaneAuthError } from "@claxedo/server-core/platform/auth/auth"
import { resolveRuntimeActor } from "@claxedo/server-core/platform/auth/runtime-actor"
import { isLoopbackLocalRequest } from "@claxedo/server-core/platform/http/peer-address"
import { ClaxedoError, errorBody, statusOf } from "@claxedo/server-core/platform/errors/base"
import type { ControlPlaneServices } from "../authority/services"
import type { MachineSessionCaller, MachineSessionDispatch } from "./machine-dispatch"
import { contentfulStatus } from "../platform/http/status"
import { asRecord, readJsonRecord, stringField } from "@claxedo/server-core/platform/json/index"

/** A scheduler dispatches existing machine sessions; it never owns an agent loop. */
export function createMachineWakes(input: {
  services: ControlPlaneServices
  runtime: MachineSessionDispatch
  store: WakeStore
  now?: () => number
}) {
  const wakes = createWakes({
    store: input.store,
    now: input.now,
    authorize: () => false,
    sinks: {
      session_turn: async (wake, result) => {
        if (!wake.sessionId || !wake.workspaceId) throw new Error("A wake requires an existing machine session")
        const caller: MachineSessionCaller | undefined = wake.createdBy
          ? { kind: "actor", actorId: wake.createdBy }
          : undefined
        if (input.services.auth.config.enabled && !caller)
          throw new Error("A signed wake requires its canonical creator")
        const binding = await input.runtime.authorize(wake.sessionId, caller)
        if (binding.workspaceId !== wake.workspaceId) throw new Error("Wake workspace does not match its session")
        const response = await input.runtime.request(
          wake.sessionId,
          "prompt_async",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              messageID: `wake:${wake.id}`,
              parts: [{ type: "text", text: `Scheduled follow-up:\n${JSON.stringify(result)}` }],
            }),
          },
          caller,
        )
        if (!response.ok) throw new Error(`Machine wake admission failed (${response.status})`)
        // prompt_async owns durable admission and deduplicates this stable message ID.
        await response.body?.cancel()
      },
    },
  })
  const routes = new Hono()
  let closing = false
  const requests = new Set<Promise<void>>()
  routes.use("*", async (c, next) => {
    if (closing) return c.json({ error: { code: "wakes_stopping", message: "The wake scheduler is stopping" } }, 503)
    let complete!: () => void
    const pending = new Promise<void>((resolve) => {
      complete = resolve
    })
    requests.add(pending)
    try {
      await next()
    } finally {
      requests.delete(pending)
      complete()
    }
    return undefined
  })
  routes.onError((error, c) => c.json(errorBody(error), contentfulStatus(statusOf(error))))
  routes.post("/sessions/:id/wakes", async (c) => {
    const auth = await controlPlaneAuthContext(c.req.raw, {
      config: input.services.auth.config,
      verifier: input.services.auth.verifier,
    })
    let caller: MachineSessionCaller | undefined
    let actorId: string | undefined
    if (auth?.mode === "signed") {
      if (!input.services.authority) throw new Error("Machine wake authority is unavailable")
      const actor = await resolveRuntimeActor(input.services.authority, auth)
      if (actor.actorKind !== "human")
        throw new ClaxedoError({
          status: 403,
          code: "wake_actor_required",
          message: "A wake requires a canonical user",
        })
      actorId = actor.actorId
      caller = auth
    } else if (input.services.auth.config.enabled || !isLoopbackLocalRequest(c.req.raw)) {
      throw new ControlPlaneAuthError(
        401,
        "missing_bearer_token",
        "A signed account or local machine connection is required",
      )
    }
    const sessionId = c.req.param("id")
    const binding = await input.runtime.authorize(sessionId, caller)
    const body = await readJsonRecord(c.req.raw)
    const wakeName = body?.name
    const wakeInput = asRecord(body?.input)
    if (
      !body ||
      (wakeName !== "schedule_followup" && wakeName !== "cancel_wake") ||
      typeof body.toolCallId !== "string" ||
      !body.toolCallId.trim() ||
      !wakeInput
    ) {
      throw new ClaxedoError({
        status: 400,
        code: "invalid_wake_request",
        message: "Provide schedule_followup or cancel_wake, input, and a stable toolCallId",
      })
    }
    // Read the authoritative last user turn; depth is not accepted from a tool.
    const historyResponse = await input.runtime.request(sessionId, "message", { method: "GET" }, caller)
    if (!historyResponse.ok) throw new Error("Cannot read the machine session for wake depth")
    const history = await historyResponse.json().catch(() => undefined)
    if (!Array.isArray(history)) throw new Error("Machine session returned invalid history")
    const currentTurn = stringField(
      asRecord(history.findLast((message) => asRecord(asRecord(message)?.info)?.role === "user")?.info),
      "id",
    )
    const parent = currentTurn?.startsWith("wake:") ? await input.store.get(currentTurn.slice(5)) : undefined
    if (currentTurn?.startsWith("wake:") && !parent) throw new Error("Current wake turn has no canonical wake record")
    if (parent && (parent.sessionId !== sessionId || parent.workspaceId !== binding.workspaceId))
      throw new Error("Wake parent does not belong to this machine session")
    const result = await handleWakeToolCall(wakeName, wakeInput, {
      wakes,
      sessionId,
      workspaceId: binding.workspaceId,
      ...(actorId ? { actor: { userId: actorId } } : {}),
      depth: parent?.depth ?? 0,
      toolCallId: body.toolCallId,
      now: input.now,
    })
    return c.json(result)
  })
  const scheduler = createScheduler(wakes, {
    onError: (error) => console.error("[machine-wakes]", error instanceof Error ? error.message : "Scheduler failed"),
  })
  return {
    routes,
    wakes,
    start: () => scheduler.start(),
    stop: async () => {
      closing = true
      await scheduler.stop()
      await Promise.all(requests)
    },
  }
}
