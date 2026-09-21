import { spawn, type ChildProcess } from "child_process"
import { isRecord } from "@claxedo/helpers/guards"

/**
 * Whether this binary is a Windows .cmd/.bat launcher, which CreateProcess
 * cannot execute directly — it must be routed through the shell. That is the
 * launcher shape an npm install puts on a Windows PATH for codex and for ACP
 * CLIs alike.
 */
export function isWindowsShimBinary(binary: string) {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(binary)
}

/**
 * Kill a spawned harness child, taking its whole process tree down on Windows.
 *
 * Two reasons this is not `proc.kill()` there:
 *
 *   - A shell-routed shim spawn's pid is cmd.exe. Killing only it leaves the
 *     real CLI running as an orphaned grandchild that keeps its cwd and open
 *     files locked — which is exactly what pins temp directories (EBUSY) and
 *     keeps a "disposed" server serving.
 *   - Windows has no signals; kill() is TerminateProcess on ONE pid either
 *     way, so the tree flag is the only part of the semantics we can choose,
 *     and dispose means the server AND its children are gone.
 *
 * On POSIX callers that spawned with `detached: true` can explicitly signal
 * their owned process group. Other callers retain single-process signaling.
 */
export function killHarnessProcess(proc: ChildProcess, signal: NodeJS.Signals, ownedProcessGroup = false) {
  if (process.platform !== "win32" && ownedProcessGroup && proc.pid) {
    try {
      process.kill(-proc.pid, signal)
    } catch (error) {
      if (!isRecord(error) || error.code !== "ESRCH") throw new Error(`Could not signal harness group ${proc.pid} with ${signal}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
    return
  }
  if (process.platform === "win32" && proc.pid && proc.exitCode === null && proc.signalCode === null) {
    try {
      return spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" })
    } catch {
      // taskkill missing or refused — fall through to the single-pid kill.
    }
  }
  try {
    proc.kill(signal)
  } catch {
    // Already exited.
  }
}

/** Wait until an owned POSIX group is gone, including children of an exited leader. */
export async function drainHarnessProcessGroup(proc: ChildProcess, timeoutMs = Infinity) {
  const pid = proc.pid
  if (process.platform === "win32" || !pid) return
  let denied: unknown
  const permissionDenied = (error: unknown) => isRecord(error) && (error.code === "EPERM" || isRecord(error.cause) && error.cause.code === "EPERM")
  const signal = (value: NodeJS.Signals) => {
    try { killHarnessProcess(proc, value, true) }
    catch (error) {
      if (!permissionDenied(error)) throw error
      denied = error
    }
  }
  signal("SIGTERM")
  const started = Date.now()
  let escalated = false
  for (;;) {
    try {
      process.kill(-pid, 0)
    } catch (error) {
      if (isRecord(error) && error.code === "ESRCH") return
      // Darwin killpg excludes zombies before counting permitted recipients,
      // so an exiting group can temporarily return EPERM. This is not proof
      // of exit: keep waiting for ESRCH and fail if permission stays denied.
      if (!permissionDenied(error)) throw new Error(`Could not inspect harness group ${pid}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
      denied = error
    }
    if (!escalated && Date.now() - started >= 1_000) {
      signal("SIGKILL")
      escalated = true
    }
    if (Date.now() - started >= timeoutMs) throw new Error(`Harness process group ${pid} did not terminate${denied instanceof Error ? `: ${denied.message}` : ""}`, { cause: denied })
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
