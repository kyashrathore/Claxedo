import type { HarnessCapabilities } from "@claxedo/agent-sdk-runtime"
import { wireAgentCapabilities } from "@claxedo/harness/capabilities"
import type { HarnessTransport, TransportCapabilities } from "@claxedo/harness/contract"
import type { HarnessHandle } from "./transports"

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
