export type RuntimeTypeHint = "workspace" | "task" | "service";

export type FanoutMode = "single" | "fanout";

/**
 * A RecurringTrigger is a durable configuration record — a run factory.
 * It is NOT a run, NOT a node, NOT an issue-hydrated work item.
 * Triggers outlive the runs they spawn and are mutable config records.
 */
export interface RecurringTrigger {
  id: string;
  title: string;
  /** Cron expression (e.g. "0 * * * *") or named preset (@hourly, @daily, @weekly, @monthly). */
  schedule: string;
  enabled: boolean;
  runtime_type_hint: RuntimeTypeHint;
  /** Optional FK to a templates table. null = no template. */
  template_id?: string;
  fanout_mode: FanoutMode;
  /** Static context payload passed into each spawned run. */
  payload?: Record<string, unknown>;
  last_run_at?: string;  // ISO 8601
  next_run_at?: string;  // ISO 8601, pre-computed
  created_at: string;    // ISO 8601
  updated_at: string;    // ISO 8601
}

export interface CreateTriggerInput {
  title: string;
  schedule: string;
  enabled?: boolean;
  runtime_type_hint?: RuntimeTypeHint;
  template_id?: string;
  fanout_mode?: FanoutMode;
  payload?: Record<string, unknown>;
}

export interface UpdateTriggerInput {
  title?: string;
  schedule?: string;
  enabled?: boolean;
  runtime_type_hint?: RuntimeTypeHint;
  template_id?: string;
  fanout_mode?: FanoutMode;
  payload?: Record<string, unknown>;
}

/** A run spawned by a trigger carries these extra fields. */
export interface TriggerSpawnedRun {
  run_id: string;
  goal: string;
  status: string;
  trigger_id: string;
  trigger_run_index: number;
}
