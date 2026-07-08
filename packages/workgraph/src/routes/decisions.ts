import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { getWorkGraph } from "../model/registry"
import type { ReviewAnswer } from "../model/workgraph"

const answerSchema = z.discriminatedUnion("action", [
  z.object({
    decision_id: z.string(),
    action: z.literal("accept"),
    payload: z.record(z.string(), z.unknown()).optional(),
    free_text_answer: z.string().optional(),
  }),
  z.object({
    decision_id: z.string(),
    action: z.literal("reject"),
  }),
  z.object({
    decision_id: z.string(),
    action: z.literal("edit"),
    payload: z.record(z.string(), z.unknown()),
    free_text_answer: z.string().optional(),
  }),
])

export function decisionsRouter() {
  const router = new Hono()

  router.get("/decisions", (c) => {
    const subjectType = c.req.query("subjectType")
    const subjectId = c.req.query("subjectId")
    const status = c.req.query("status")
    const decisions = Object.values(getWorkGraph().getState().decisions)
      .filter((decision) => !subjectType || decision.subjectType === subjectType)
      .filter((decision) => !subjectId || decision.subjectId === subjectId)
      .filter((decision) => status ? decision.status === status : decision.status === "open")
    return c.json({ decisions })
  })

  router.get("/decisions/:id", (c) => {
    const decision = getWorkGraph().getDecision(c.req.param("id"))
    if (!decision) return c.json({ error: "Decision not found" }, 404)
    return c.json(decision)
  })

  router.post(
    "/review-batches",
    zValidator("json", z.object({
      submitted_by: z.string().optional(),
      answers: z.array(answerSchema).min(1),
    })),
    (c) => {
      try {
        const body = c.req.valid("json")
        return c.json(getWorkGraph().submitReviewBatch({
          submittedBy: body.submitted_by,
          answers: body.answers.map((answer): ReviewAnswer => {
            if (answer.action === "reject") return { decisionId: answer.decision_id, action: "reject" }
            if (answer.action === "edit") {
              return {
                decisionId: answer.decision_id,
                action: "edit",
                payload: answer.payload,
                freeTextAnswer: answer.free_text_answer,
              }
            }
            return {
              decisionId: answer.decision_id,
              action: "accept",
              payload: answer.payload,
              freeTextAnswer: answer.free_text_answer,
            }
          }),
        }), 201)
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400)
      }
    },
  )

  return router
}
