import { TransportError } from "../../contract/errors.js"

export class OpenCodeOwnerMismatchError extends TransportError {
  constructor() {
    super("opencode", "owner", "OpenCode engine credentials belong to another session owner")
    this.name = "OpenCodeOwnerMismatchError"
  }
}
