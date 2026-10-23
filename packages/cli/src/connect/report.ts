import { readFileSync } from "node:fs"
import os from "node:os"
import type { MachineBlockedReason } from "@claxedo/account-contract/machine"
import { hostKeyPairFromJwk } from "@claxedo/host-connector/host-identity"
import type { HostState } from "@claxedo/host-connector/host-state"
import { createMachineReportClient, type FetchLike } from "@claxedo/host-connector/machine-transport"
import { errorMessage } from "../json"
import { cliVersion } from "../version"

/** A report rides on the way out of a refusal or a stop, so it may not hold either up for long. */
const REPORT_TIMEOUT_MS = 5_000

export type MachineBlock = { reason: MachineBlockedReason; fix: string }

export function operatingSystem() {
  if (process.platform === "darwin") return "macOS"
  if (process.platform === "win32") return os.version() || "Windows"
  try {
    const release = readFileSync("/etc/os-release", "utf8")
    return /^PRETTY_NAME="?([^"\n]+)"?/m.exec(release)?.[1] ?? `Linux ${os.release()}`
  } catch {
    return `Linux ${os.release()}`
  }
}

/** What starts this machine's `claxedo connect` again after it was stopped: its service when it has one. */
export function restartCommand(state: HostState) {
  return state.service ? "claxedo connect --install-service" : "claxedo connect"
}

/**
 * Tells the control plane this machine's CLI version and system and, when it
 * cannot serve, why and what fixes it, so its owner reads it in the app. A
 * report that fails is logged and changes nothing else: the machine's own
 * output already says the same.
 */
export async function reportMachine(
  state: HostState,
  input: { fetch: FetchLike; log: (line: string) => void; generation?: number; blocked?: MachineBlock },
) {
  const enrollment = state.enrollment
  if (!enrollment) return
  try {
    const client = createMachineReportClient({
      controlPlaneUrl: state.control_plane_url,
      keys: await hostKeyPairFromJwk(state.private_key_jwk),
      enrollmentId: enrollment.enrollment_id,
      hostId: state.host_id,
      keyVersion: enrollment.key_version,
      fetch: input.fetch,
      requestTimeoutMs: REPORT_TIMEOUT_MS,
    })
    await client.report({
      cliVersion: cliVersion(),
      os: operatingSystem(),
      arch: process.arch,
      ...(input.generation === undefined ? {} : { generation: input.generation }),
      ...(input.blocked ? { blocked: input.blocked } : {}),
    })
  } catch (error) {
    input.log(`could not report to the control plane: ${errorMessage(error)}`)
  }
}
