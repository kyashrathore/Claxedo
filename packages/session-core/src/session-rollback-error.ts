/**
 * Raised when creating a session failed and the compensating rollback failed
 * too, so the remote conversation the provider already opened is orphaned.
 *
 * Both failures matter and both are kept. `errors` carries the creation failure
 * alongside the rollback failure, and `cause` is the rollback failure — the one
 * that turned a recoverable error into an orphaned session, and the stack a
 * reader needs first. Reporting only one of them has been the trap here: the
 * creation error explains what the caller asked for, the rollback error
 * explains why nothing undid it.
 */
export class SessionRollbackError extends AggregateError {
  override readonly name = "SessionRollbackError"

  constructor(
    /** Which layer's rollback failed — the runtime's own store, or the provider's remote session. */
    stage: "runtime" | "provider",
    creationError: unknown,
    rollbackError: unknown,
  ) {
    super([creationError, rollbackError], `Session creation failed and ${stage} rollback also failed`, {
      cause: rollbackError,
    })
  }
}
