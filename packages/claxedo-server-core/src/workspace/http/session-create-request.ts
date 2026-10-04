/**
 * The workspace runtime's session-create call, as one description.
 *
 * Every caller that creates a session in a workspace runtime — the machine
 * dispatch behind the session routes, and the Tasks session bridge — sends the
 * same path and the same body, and a field added to the runtime's create
 * contract has to reach both. Spelling it twice is how one of them is missed.
 */
import type { SessionHarness, SessionModelGroup } from "@claxedo/agent-runtime-contract"

export type WorkspaceSessionCreate = {
  /** Absent lets the runtime mint the id; present is an id a reservation already holds. */
  id?: string
  title?: string
  model?: { providerID: string; modelID: string }
  /** Reasoning effort, under the runtime's own name for it. */
  variant?: string
  /** Retained on the session and reapplied by the runtime on every later turn. */
  instructions?: string
  /** The model each slot of a started group runs, for a session a delegation can continue. */
  group?: SessionModelGroup
  harness?: SessionHarness
}

export function sessionCreateRequest(input: WorkspaceSessionCreate): { path: string; body: string } {
  return {
    path: `/session${input.harness ? `?${sessionHarnessQuery(input.harness)}` : ""}`,
    body: JSON.stringify({
      ...(input.id ? { id: input.id } : {}),
      title: input.title,
      model: input.model,
      ...(input.variant ? { variant: input.variant } : {}),
      ...(input.instructions ? { instructions: input.instructions } : {}),
      ...(input.group ? { group: input.group } : {}),
    }),
  }
}

/** Which harness a session request names, under the query parameter its access kind is read from. */
export function sessionHarnessQuery(harness: SessionHarness): string {
  return `${harness.access === "native" ? "nativeHarness" : "connectionId"}=${encodeURIComponent(harness.id)}`
}
