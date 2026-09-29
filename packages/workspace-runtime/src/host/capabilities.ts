import type { AgentCapabilities, HarnessEffortLevels, HarnessInstructionChannel, SessionHarnessId } from "@claxedo/agent-runtime-contract"
import { wireAgentCapabilities } from "@claxedo/harness/capabilities"
import type { HarnessTransport, TransportCapabilities } from "@claxedo/harness/contract"
import type { HarnessHandle } from "./transports"

export type HarnessCapabilities = Omit<AgentCapabilities, "harness" | "modelSelection"> &
  Partial<Pick<AgentCapabilities, "modelSelection">> & {
  harness: SessionHarnessId
  abort: boolean
  reconnect: boolean
  replay: boolean
  permissions: boolean
  questions: boolean
  todos: boolean
  commands: boolean
  fork: boolean
  revert: boolean
  unrevert: boolean
  configOptions: boolean
  subagents: boolean
  /** Runtime availability only. Detailed support is read from the transport's declared goal capabilities. */
  goals: boolean
  /**
   * Which effort levels this harness accepts, per model. Required because a
   * missing catalog reads as `unresolved` to every consumer, which accepts —
   * so a transport that forgot one would silently drop the effort it was given.
   */
  effortLevels: HarnessEffortLevels
  /**
   * How this harness takes a session's standing instruction block. A host that
   * composes one decides from this whether it arrives as instruction or at the
   * head of the user's own prompt text.
   */
  instructionChannel: HarnessInstructionChannel
  }

/**
 * The public capability record for one harness, projected once from the
 * transport's declared capabilities and its operation groups. `abort` is the
 * host's own fact: a session can be aborted unless it is an ACP child, which
 * only its parent's agent can stop.
 */
export function harnessCapabilitiesFor(
  handle: Pick<HarnessHandle, "runner" | "kind">,
  transport: Pick<HarnessTransport, "config" | "history" | "commands" | "fork">,
  declared: TransportCapabilities,
  session: { child: boolean },
): HarnessCapabilities {
  const abort = !(handle.kind === "acp" && session.child)
  const wire = wireAgentCapabilities(declared, transport, { harness: handle.runner.id, transport: handle.kind, abort })
  return {
    ...wire,
    harness: handle.runner.id,
    goals: declared.goals.implemented,
    effortLevels: declared.effortLevels,
    instructionChannel: declared.instructionChannel,
  }
}
