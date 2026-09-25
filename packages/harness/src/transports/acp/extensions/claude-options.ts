import type { InitializeResponse, NewSessionRequest } from "@agentclientprotocol/sdk"
import type { StartInput } from "../../../contract"
import { AcpTransportError } from "../errors"

export function claudeOptionsMeta(handshake: InitializeResponse, input: Pick<StartInput, "locality" | "projection">): NewSessionRequest["_meta"] | undefined {
  if (input.locality === "remote" || input.projection.pluginRoots.length === 0) return undefined
  if (handshake.agentInfo?.name !== "claude-agent-acp" || handshake.agentInfo.version !== "0.63.0") {
    throw new AcpTransportError("configuration", "ACP agent version does not declare verified Claude plugin delivery")
  }
  return { claudeCode: { options: { plugins: input.projection.pluginRoots.map((plugin) => ({ type: "local", path: plugin.root })) } } }
}
