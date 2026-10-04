export class CredentialDeliveryError extends Error {
  constructor(cause: unknown) {
    super("Stored credentials could not be delivered to running workspaces", { cause })
    this.name = "CredentialDeliveryError"
  }
}
