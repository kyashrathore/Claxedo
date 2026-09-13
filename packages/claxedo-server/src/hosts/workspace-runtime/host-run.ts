import { startServer, waitForWorkspaceRuntimeServerPort } from "@claxedo/workspace-runtime"
import type { ClaxedoWorkspaceRuntimeBoot } from "./runtime-boot"

/**
 * Where a host entry's two lines of output and its exit go. Injected so the
 * failure path can be exercised without ending the test runner's process.
 */
export type WorkspaceRuntimeHostIo = {
  log: (line: string) => void
  error: (line: string) => void
  exit: (code: number) => never
}

/** Named in the stderr line so a log search finds boot failures by one string. */
const WORKSPACE_RUNTIME_BOOT_FAILED = "workspace_runtime_boot_failed"

const BOOT_FAILURE_EXIT_CODE = 78

/**
 * Boot the runtime host, or fail where the driver can see it.
 *
 * A rejected top-level `await` in an entry module kills the process with no
 * output, so the driver's readiness probe reports nothing but a timeout and the
 * real cause — a malformed env var, an unwritable git config — never leaves the
 * sandbox.
 */
export async function runWorkspaceRuntimeHost(
  boot: () => Promise<ClaxedoWorkspaceRuntimeBoot>,
  io: WorkspaceRuntimeHostIo = {
    log: (line) => console.log(line),
    error: (line) => console.error(line),
    exit: (code) => process.exit(code),
  },
): Promise<void> {
  let started: ClaxedoWorkspaceRuntimeBoot
  try {
    started = await boot()
  } catch (err) {
    io.error(`[claxedo-workspace-runtime] ${WORKSPACE_RUNTIME_BOOT_FAILED}: ${
      err instanceof Error ? (err.stack ?? err.message) : String(err)
    }`)
    io.exit(BOOT_FAILURE_EXIT_CODE)
    return
  }
  const server = startServer(started.port, started.options, { signals: true })
  const port = await waitForWorkspaceRuntimeServerPort(server, started.port)
  io.log(
    `[claxedo-workspace-runtime] listening on http://${started.hostname}:${port}`
    + ` workspaceId=${started.options.target?.workspaceId} directory=${started.options.target?.directory}`,
  )
}
