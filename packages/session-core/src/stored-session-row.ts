import type { AgentSessionTitleSource } from "@claxedo/agent-runtime-contract"

/** A `session` row with its execution binding's workspace, as every session read selects it. */
export type StoredSessionRow = {
  id: string
  workspace_id: string | null
  parent_id: string | null
  directory: string
  title: string | null
  title_source?: AgentSessionTitleSource | null
  commands_json: string | null
  process_key: string | null
  harness_id: string | null
  harness_access: string | null
  harness_binary: string | null
  harness_transport: string | null
  harness_url: string | null
  harness_headers_json: string | null
  model_provider_id: string | null
  model_id: string | null
  variant: string | null
  agent: string | null
  permission_mode: string | null
  permission_mode_label: string | null
  created_at: number
  updated_at: number
  last_human_turn_at: number | null
  status: string | null
  recovery_error: string | null
  archived_at: number | null
  agent_session_id: string | null
}

export const STORED_SESSION_SELECT = `
  SELECT
    session.id, binding.workspace_id, parent_id, session.directory, title, title_source, commands_json,
    process_key, harness_id, harness_access, harness_binary, harness_transport, harness_url, harness_headers_json,
    model_provider_id, model_id, variant, agent, permission_mode, permission_mode_label,
    created_at, updated_at, last_human_turn_at, status, recovery_error, archived_at, agent_session_id
  FROM session
  LEFT JOIN session_execution_binding binding ON binding.session_id = session.id`
