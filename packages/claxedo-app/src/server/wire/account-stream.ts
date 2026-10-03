import type { HostedStreamBridge } from "@claxedo/account-contract"
import { hostedOperationError } from "../errors"

export function reserveAccountEvents(bridge: HostedStreamBridge, headers: Headers) {
  const lastEventId = headers.get("Last-Event-ID")
  return bridge.streamOpen("controlPlane.events", lastEventId ? { lastEventId } : {})
}

export function accountStreamError(error: unknown) {
  return hostedOperationError("controlPlane.events", error)
}
