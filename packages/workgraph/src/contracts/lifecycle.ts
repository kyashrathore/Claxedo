import { z } from "zod"

export const StreamLifecycleStateSchema = z.enum(["active", "paused", "closed", "reopened"])
export type StreamLifecycleState = z.infer<typeof StreamLifecycleStateSchema>

export const StreamVisibilitySchema = z.enum(["visible", "archived"])
export type StreamVisibility = z.infer<typeof StreamVisibilitySchema>

export const OutcomeStateSchema = z.enum(["pending", "active", "ready_to_close", "completed", "blocked", "reopened"])
export type OutcomeState = z.infer<typeof OutcomeStateSchema>

export const WorkItemStateSchema = z.enum([
  "draft",
  "pending_approval",
  "pending",
  "active",
  "result_ready",
  "review_needed",
  "integration_needed",
  "blocked",
  "verification_failed",
  "completed",
  "failed",
  "abandoned",
])
export type WorkItemState = z.infer<typeof WorkItemStateSchema>

export const RunStateSchema = z.enum(["admitted", "placing", "running", "result", "parked", "failed", "cancelled"])
export type RunState = z.infer<typeof RunStateSchema>

export const DecisionStateSchema = z.enum(["proposed", "pending", "answered", "dismissed"])
export type DecisionState = z.infer<typeof DecisionStateSchema>
