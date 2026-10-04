/** Provider- and storage-neutral failure raised while assembling a hosted artifact. */
export class HostedWorkerCompositionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "HostedWorkerCompositionError"
  }
}
