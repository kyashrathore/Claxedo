import { TransportError } from "../../contract/errors"

export class AcpTransportError extends TransportError {
  constructor(readonly code: "connection" | "protocol" | "session" | "timeout" | "configuration" | "ownership", message: string, cause?: unknown) {
    super("acp", code, message, { cause })
  }
}
