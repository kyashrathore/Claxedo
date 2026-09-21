export type ExecutionAvailability =
  | { status: "available" }
  | { status: "selection-required"; selection: "harness" | "model" }
  | { status: "offline"; message: string }
  | { status: "unsupported"; operation: string }
  | { status: "unavailable"; message: string; connectionId?: string }
  | { status: "upstream-error"; message: string; connectionId?: string }

export type AgentRuntimeStatus =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt: number; message: string; next: number; action?: { reason: string; provider: string; title: string; message: string; label: string; link?: string } }
  | { type: "recovering"; kind: "process_restart" | "uncertain_execution"; message: string }
