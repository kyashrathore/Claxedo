import path from "node:path"
import { randomUUID } from "node:crypto"
import { asFiniteNumber, asRecordOrEmpty } from "@claxedo/helpers/guards"
import { trimToUndefined } from "@claxedo/helpers/string"
import { normalizeAbsolutePath } from "@claxedo/host-connector/host-state"
import { requireAccessToken } from "../auth/token-store"
import { config, url } from "../config"
import { takeValue } from "../connect/args"
import { requestJson } from "../http"

export type HostDeps = {
  request: typeof requestJson
  token: () => Promise<string>
  controlPlaneUrl: string
  log: (line: string) => void
  now: () => number
}

export function defaultHostCommandDeps(): HostDeps {
  return {
    request: requestJson,
    token: requireAccessToken,
    controlPlaneUrl: config().controlPlaneUrl,
    log: (line) => console.log(line),
    now: () => Date.now(),
  }
}

export const hostUsage = `claxedo host invite --name N --root DIR... [--expires 1h] [--org-visible]
claxedo host list
claxedo host assign --machine <name|enrollment_id> <dir> [--name N]
claxedo host unassign --machine <name|enrollment_id> <dir>
claxedo host scope --machine <name|enrollment_id> --root DIR... [--org-visible]
claxedo host revoke --machine <name|enrollment_id>`

export const hostHelp = `${hostUsage}

Owner commands, run from a signed-in laptop (\`claxedo login\`), never on the host.
  invite    mints a single-use invitation (default 1 h, 5m–24h) scoped to the roots; the token prints ONCE
  list      every enrolled machine: name, enrollment id, host id, key fingerprint, generation, online (yes, no, or paused)
  assign    have a machine serve <dir> (absolute, under its roots); re-points the workspace already assigned to that machine at <dir>, else creates a new one
  unassign  stop serving <dir>; the workspace assigned to that machine at <dir> is retired
  scope     replace a machine's allowed roots; assignments outside them are retired
  revoke    revoke a machine for good (assignments, readiness and tokens cascade); its next beat is refused and \`claxedo connect\` exits 78
--machine matches an enrollment id, else a display name exactly (case-sensitive); an ambiguous name is refused.
--org-visible lets ordinary org members open the machine's workspaces; default is owner, direct and project members, and org admins only.`

export type Machine = {
  enrollment_id: string
  display_name: string
  host_id: string
  public_key_fingerprint: string | undefined
  serving_generation: number | undefined
  expires_at: number | undefined
  last_seen_at: number | undefined
  enrolled_via: string | undefined
  /** Set while the owner has paused the enrollment; its beats are refused until resumed. */
  paused_at: number | undefined
  /** The owner's declarations for this machine, acked or not, as the list row carries them. */
  assignments: Array<{ workspace_id: string; remote_directory: string; display_name: string | undefined }>
  scope: { allowed_roots: string[]; visibility: string } | undefined
}

export function machineRow(input: unknown): Machine | undefined {
  const row = asRecordOrEmpty(input)
  const enrollmentId = trimToUndefined(row.enrollment_id)
  const hostId = trimToUndefined(row.host_id)
  if (!enrollmentId || !hostId) return undefined
  const scope = asRecordOrEmpty(row.scope)
  const roots = Array.isArray(scope.allowed_roots) ? scope.allowed_roots.filter((root): root is string => typeof root === "string") : undefined
  return {
    enrollment_id: enrollmentId,
    display_name: trimToUndefined(row.display_name) ?? "",
    host_id: hostId,
    public_key_fingerprint: trimToUndefined(row.public_key_fingerprint),
    serving_generation: asFiniteNumber(row.serving_generation),
    expires_at: asFiniteNumber(row.expires_at),
    last_seen_at: asFiniteNumber(row.last_seen_at),
    enrolled_via: trimToUndefined(row.enrolled_via),
    paused_at: asFiniteNumber(row.paused_at),
    assignments: (Array.isArray(row.assignments) ? row.assignments : []).flatMap((entry) => {
      const assignment = asRecordOrEmpty(entry)
      const workspaceId = trimToUndefined(assignment.workspace_id)
      const remoteDirectory = trimToUndefined(assignment.remote_directory)
      return workspaceId && remoteDirectory
        ? [{ workspace_id: workspaceId, remote_directory: remoteDirectory, display_name: trimToUndefined(assignment.display_name) }]
        : []
    }),
    scope: roots ? { allowed_roots: roots, visibility: trimToUndefined(scope.visibility) ?? "owner" } : undefined,
  }
}

export function machineOnline(machine: Machine, now: number) {
  if (machine.paused_at !== undefined) return "paused"
  return machine.expires_at !== undefined && machine.expires_at > now ? "yes" : "no"
}

/** An enrollment id wins outright; otherwise the display name, exactly, and only when it names one machine. */
export function resolveMachine(machines: Machine[], selector: string): Machine {
  const byId = machines.find((machine) => machine.enrollment_id === selector)
  if (byId) return byId
  const byName = machines.filter((machine) => machine.display_name === selector)
  if (byName.length === 1) return byName[0]
  if (byName.length === 0) throw new Error(`No machine named ${selector}; \`claxedo host list\` shows the enrolled ones`)
  throw new Error(
    `${byName.length} machines are named ${selector}; pass the enrollment id instead: ${byName.map((machine) => machine.enrollment_id).join(", ")}`,
  )
}

type Parsed = {
  positional: string[]
  machine?: string
  name?: string
  roots: string[]
  expires?: string
  orgVisible: boolean
}

function parseHostArgs(args: string[]): Parsed {
  const parsed: Parsed = { positional: [], roots: [], orgVisible: false }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? ""
    if (arg === "--machine" || arg.startsWith("--machine=")) {
      const taken = takeValue(args, i, "--machine")
      parsed.machine = taken.value
      i = taken.next
      continue
    }
    if (arg === "--name" || arg.startsWith("--name=")) {
      const taken = takeValue(args, i, "--name")
      parsed.name = taken.value
      i = taken.next
      continue
    }
    if (arg === "--root" || arg.startsWith("--root=")) {
      const taken = takeValue(args, i, "--root")
      if (!taken.value.startsWith("/")) throw new Error(`--root must be an absolute path: ${taken.value}`)
      parsed.roots.push(taken.value)
      i = taken.next
      continue
    }
    if (arg === "--expires" || arg.startsWith("--expires=")) {
      const taken = takeValue(args, i, "--expires")
      parsed.expires = taken.value
      i = taken.next
      continue
    }
    if (arg === "--org-visible") {
      parsed.orgVisible = true
      continue
    }
    if (arg.startsWith("-")) throw new Error(`Unknown host option: ${arg}\n${hostUsage}`)
    parsed.positional.push(arg)
  }
  return parsed
}

/** `30m`, `2h`, `1d`; the control plane clamps to [5 min, 24 h]. */
export function parseExpires(input: string | undefined): number {
  if (input === undefined) return 60 * 60_000
  const match = /^(\d+)([mhd])$/.exec(input.trim())
  if (!match) throw new Error(`--expires wants <n>m, <n>h or <n>d, not ${input}`)
  const units: Record<string, number> = { m: 60_000, h: 60 * 60_000, d: 24 * 60 * 60_000 }
  return Number(match[1]) * units[match[2]]
}

function requireMachineSelector(parsed: Parsed) {
  if (!parsed.machine) throw new Error(`--machine <name|enrollment_id> is required; there is no default machine\n${hostUsage}`)
  return parsed.machine
}

/**
 * The directory in the form the control plane records it (`normalizeStoredDirectory`
 * there, the same rule as `normalizeAbsolutePath`): `/srv/app/` and `/srv/app`
 * are one folder, so the match against the machine's assignments and the
 * value sent are both the normalized one.
 */
function requireMachineDirectory(parsed: Parsed) {
  const directory = parsed.positional[0]
  if (!directory) throw new Error(`a directory on the machine is required\n${hostUsage}`)
  const normalized = normalizeAbsolutePath(directory)
  if (normalized === undefined) throw new Error(`the directory must be an absolute path on the machine: ${directory}`)
  return normalized
}

async function listMachines(deps: HostDeps, token: string) {
  const response = asRecordOrEmpty(
    await deps.request({ url: url(deps.controlPlaneUrl, "/api/claxedo/host/enrollments"), token }),
  )
  const rows = Array.isArray(response.machines) ? response.machines : []
  return rows.map(machineRow).filter((machine): machine is Machine => machine !== undefined)
}

async function selectMachine(deps: HostDeps, token: string, selector: string) {
  return resolveMachine(await listMachines(deps, token), selector)
}

/**
 * The workspace the owner has assigned to THIS machine at `directory`, acked
 * or not; another machine's at the same string is never it. Two of them is a
 * control-plane state this command cannot disambiguate, so it names both
 * and writes nothing.
 */
function machineWorkspaceAt(machine: Machine, directory: string) {
  const matches = machine.assignments.filter((assignment) => normalizeAbsolutePath(assignment.remote_directory) === directory)
  if (matches.length > 1) {
    throw new Error(
      `${machine.display_name || machine.enrollment_id} has ${matches.length} workspaces at ${directory} (${matches.map((match) => match.workspace_id).join(", ")}); this command cannot tell which is meant — retire one at the control plane first`,
    )
  }
  return matches[0]
}

function fixedWidth(rows: string[][]) {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => (row[column] ?? "").length)))
  return rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd())
}

export function inviteOutput(input: { token: string; expiresAt: number; name: string; roots: string[]; visibility: string }) {
  return [
    `Invitation for ${input.name} (roots: ${input.roots.join(", ")}; visibility: ${input.visibility})`,
    `Expires: ${new Date(input.expiresAt).toISOString()}`,
    "",
    "Token (shown once; single use):",
    input.token,
    "",
    "On the machine, save the token to a file readable only by the service user, then:",
    `  claxedo connect --token-file <file>${input.roots.map((root) => ` --root ${root}`).join("")} --install-service`,
  ]
}

async function inviteMachine(deps: HostDeps, parsed: Parsed) {
  if (!parsed.name) throw new Error(`--name is required: the machine's display name\n${hostUsage}`)
  if (parsed.roots.length === 0) throw new Error(`at least one --root is required: an invitation with no roots can serve nothing\n${hostUsage}`)
  const expiresInMs = parseExpires(parsed.expires)
  const visibility = parsed.orgVisible ? "org" : "owner"
  const token = await deps.token()
  const response = asRecordOrEmpty(
    await deps.request({
      url: url(deps.controlPlaneUrl, "/api/claxedo/host/invitations"),
      token,
      body: { displayName: parsed.name, scope: { allowed_roots: parsed.roots, visibility }, expiresInMs },
    }),
  )
  const minted = trimToUndefined(response.token)
  if (!minted) throw new Error("The control plane returned no invitation token")
  for (const line of inviteOutput({
    token: minted,
    expiresAt: asFiniteNumber(response.expires_at) ?? deps.now() + expiresInMs,
    name: parsed.name,
    roots: parsed.roots,
    visibility,
  })) {
    deps.log(line)
  }
}

async function printMachines(deps: HostDeps) {
  const machines = await listMachines(deps, await deps.token())
  if (machines.length === 0) {
    deps.log("No machines are enrolled. `claxedo host invite` mints an invitation.")
    return
  }
  const now = deps.now()
  const rows = [
    ["NAME", "ENROLLMENT", "HOST", "FINGERPRINT", "GEN", "ONLINE", "ROOTS"],
    ...machines.map((machine) => [
      machine.display_name || "-",
      machine.enrollment_id,
      machine.host_id,
      machine.public_key_fingerprint?.slice(0, 16) ?? "-",
      machine.serving_generation === undefined ? "-" : String(machine.serving_generation),
      machineOnline(machine, now),
      machine.scope?.allowed_roots.join(",") ?? "-",
    ]),
  ]
  for (const line of fixedWidth(rows)) deps.log(line)
}

async function assignFolder(deps: HostDeps, parsed: Parsed) {
  const selector = requireMachineSelector(parsed)
  const directory = requireMachineDirectory(parsed)
  const token = await deps.token()
  const machine = await selectMachine(deps, token, selector)
  const existing = machineWorkspaceAt(machine, directory)
  const workspaceId = existing?.workspace_id ?? `ws_${randomUUID().replaceAll("-", "")}`
  const displayName = parsed.name ?? existing?.display_name ?? path.posix.basename(directory)
  await deps.request({
    url: url(deps.controlPlaneUrl, `/api/workspace/${encodeURIComponent(workspaceId)}/host-assignment`),
    token,
    body: {
      hostId: machine.host_id,
      displayName,
      repoName: path.posix.basename(directory),
      remoteDirectory: directory,
    },
  })
  deps.log(`${machine.display_name || machine.enrollment_id} will serve ${directory} as ${workspaceId} (${displayName}); it acks on its next beat`)
}

async function unassignFolder(deps: HostDeps, parsed: Parsed) {
  const selector = requireMachineSelector(parsed)
  const directory = requireMachineDirectory(parsed)
  const token = await deps.token()
  const machine = await selectMachine(deps, token, selector)
  const workspaceId = machineWorkspaceAt(machine, directory)?.workspace_id
  if (!workspaceId) throw new Error(`${machine.display_name || machine.enrollment_id} is not assigned ${directory}`)
  await deps.request({
    url: url(deps.controlPlaneUrl, `/api/workspace/${encodeURIComponent(workspaceId)}/host-assignment`),
    method: "DELETE",
    token,
  })
  deps.log(`${machine.display_name || machine.enrollment_id} no longer serves ${directory} (${workspaceId} retired)`)
}

async function scopeMachine(deps: HostDeps, parsed: Parsed) {
  const selector = requireMachineSelector(parsed)
  if (parsed.roots.length === 0) throw new Error(`at least one --root is required\n${hostUsage}`)
  const token = await deps.token()
  const machine = await selectMachine(deps, token, selector)
  const visibility = parsed.orgVisible ? "org" : "owner"
  await deps.request({
    url: url(deps.controlPlaneUrl, `/api/claxedo/host/enrollments/${encodeURIComponent(machine.enrollment_id)}/scope`),
    method: "PATCH",
    token,
    body: { allowed_roots: parsed.roots, visibility },
  })
  deps.log(
    `${machine.display_name || machine.enrollment_id}: roots ${parsed.roots.join(", ")} (visibility ${visibility}); assignments outside them are retired on its next beat`,
  )
}

async function revokeMachine(deps: HostDeps, parsed: Parsed) {
  const selector = requireMachineSelector(parsed)
  const token = await deps.token()
  const machine = await selectMachine(deps, token, selector)
  await deps.request({
    url: url(deps.controlPlaneUrl, `/api/claxedo/remote-access/devices/${encodeURIComponent(machine.host_id)}`),
    method: "DELETE",
    token,
  })
  deps.log(
    `${machine.display_name || machine.enrollment_id} revoked: its assignments and runtime tokens are gone, its next beat is refused and \`claxedo connect\` there exits 78; the host id is never reusable`,
  )
}

export async function hostCommand(args: string[], deps: HostDeps = defaultHostCommandDeps()) {
  const [subcommand, ...rest] = args
  if (!subcommand || subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    deps.log(hostHelp)
    return
  }
  const parsed = parseHostArgs(rest)
  if (subcommand === "invite") return inviteMachine(deps, parsed)
  if (subcommand === "list") return printMachines(deps)
  if (subcommand === "assign") return assignFolder(deps, parsed)
  if (subcommand === "unassign") return unassignFolder(deps, parsed)
  if (subcommand === "scope") return scopeMachine(deps, parsed)
  if (subcommand === "revoke") return revokeMachine(deps, parsed)
  throw new Error(`Unknown host subcommand: ${subcommand}\n${hostUsage}`)
}
