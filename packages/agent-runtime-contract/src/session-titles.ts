import type { PromptModel } from "./sessions"

/**
 * What a harness receives when the runtime asks it for a title: the shared
 * instruction, the conversation excerpt, and the session's own model, so
 * the side turn runs under the same credentials as the session.
 */
export type SessionTitleRequest = {
  directory: string
  system: string
  user: string
  /** The session's selected model; absent when the session runs the harness default. */
  model?: PromptModel
  signal: AbortSignal
}
