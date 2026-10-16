/**
 * What the sandbox Worker reads about a runtime's boot. The Worker bundles this
 * module, so it imports nothing.
 */

/**
 * How long a runtime may spend checking out its repository before it exits
 * with the reason. A runtime still neither ready nor exited well past it is
 * wedged.
 */
export const RUNTIME_PREPARATION_DEADLINE_MS = 30 * 60_000

/** Names the file the runtime appends its own warning and error lines to, the only output its sandbox forwards to operators. */
export const WORKSPACE_RUNTIME_OPERATOR_LOG = "WORKSPACE_RUNTIME_OPERATOR_LOG"

/** Leads the stderr line a runtime whose boot failed prints before it exits. */
export const WORKSPACE_RUNTIME_BOOT_FAILED = "workspace_runtime_boot_failed"
