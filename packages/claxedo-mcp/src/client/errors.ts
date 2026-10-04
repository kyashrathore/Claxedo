export type ClaxedoMcpClientErrorCode =
  | "local-runtime-required"
  | "control-plane-required"
  | "unresolvable-target"
  | "connection-invalid"
  | "connection-provisioning"

export class ClaxedoMcpClientError extends Error {
  constructor(
    readonly code: ClaxedoMcpClientErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "ClaxedoMcpClientError"
  }
}
