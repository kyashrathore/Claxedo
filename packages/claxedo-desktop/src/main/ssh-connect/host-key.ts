import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { readTextIfExists } from "@claxedo/helpers/fs"
import { runSshTool, sshFailure, sshOptions, type SshFailure, type SshTarget, type SshTools } from "./ssh"

export type HostKey = { readonly type: string; readonly fingerprint: string }

export type HostKeyScan =
  | { readonly kind: "scanned"; readonly keys: readonly HostKey[]; readonly lines: readonly string[] }
  | { readonly kind: "failed"; readonly failure: SshFailure }

const SCAN_DEADLINE_MS = 30_000
const FINGERPRINT = /^\d+ (\S+) .* \(([A-Z0-9-]+)\)$/

async function readLines(file: string): Promise<string[]> {
  const text = (await readTextIfExists(file)) ?? ""
  return text.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"))
}

async function fingerprints(tools: SshTools, file: string): Promise<HostKey[]> {
  const listed = await runSshTool(tools, "sshKeygen", ["-l", "-f", file])
  if (listed.kind !== "exited" || listed.code !== 0) return []
  return listed.stdout.split("\n").flatMap((line) => {
    const match = FINGERPRINT.exec(line.trim())
    return match?.[1] && match[2] ? [{ fingerprint: match[1], type: match[2] }] : []
  })
}

/**
 * Asks the host for its key the way ssh itself would reach it (its config,
 * ProxyJump, HostKeyAlias), into a throwaway known_hosts, and authenticates
 * with nothing: no key or agent is offered to a host nobody has trusted yet.
 */
export async function scanHostKey(tools: SshTools, target: SshTarget): Promise<HostKeyScan> {
  const dir = await mkdtemp(join(tmpdir(), "claxedo-ssh-scan-"))
  try {
    const knownHosts = join(dir, "known_hosts")
    const options = [
      ...sshOptions(target, "accept-new"),
      "-o", `UserKnownHostsFile=${knownHosts}`,
      "-o", `GlobalKnownHostsFile=${join(dir, "none")}`,
      "-o", "PreferredAuthentications=none",
      "-o", "IdentityAgent=none",
    ]
    const exit = await runSshTool(tools, "ssh", [...options, "--", target.destination, "true"], { deadlineMs: SCAN_DEADLINE_MS })
    if (exit.kind === "missing") return { kind: "failed", failure: { reason: "sshMissing" } }
    const lines = await readLines(knownHosts)
    const keys = lines.length ? await fingerprints(tools, knownHosts) : []
    if (!keys.length) return { kind: "failed", failure: { reason: exit.kind === "exited" ? sshFailure(exit.stderr) : "unreachable" } }
    return { kind: "scanned", keys, lines }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function knownHostsFile(tools: SshTools, target: SshTarget): Promise<string | undefined> {
  const resolved = await runSshTool(tools, "ssh", ["-G", ...sshOptions(target), "--", target.destination])
  if (resolved.kind !== "exited" || resolved.code !== 0) return undefined
  const line = resolved.stdout.split("\n").find((entry) => entry.startsWith("userknownhostsfile "))
  const file = line?.slice("userknownhostsfile ".length).trim().split(/\s+/)[0]?.replace(/^"|"$/g, "")
  return file && file !== "none" && file !== "/dev/null" ? file : undefined
}

/** The person's own known_hosts, as ssh -G names it, so their terminal ssh trusts the host from now on too. */
export async function recordHostKey(tools: SshTools, target: SshTarget, lines: readonly string[]): Promise<boolean> {
  const file = await knownHostsFile(tools, target)
  if (!file) return false
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const existing = (await readTextIfExists(file)) ?? ""
  const separator = existing && !existing.endsWith("\n") ? "\n" : ""
  await appendFile(file, `${separator}${lines.join("\n")}\n`, { mode: 0o600 })
  return true
}
