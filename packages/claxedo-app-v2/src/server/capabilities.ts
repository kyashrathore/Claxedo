import { AGENT_HARNESS_IDS, HARNESS_EFFORT_LEVELS, HARNESS_TABLE } from "@claxedo/agent-runtime-contract"
import { createSignal, type Accessor } from "solid-js"
import { probeAvailability } from "./availability"
import { DOCUMENTS_PATH } from "./documents"
import { responseError, toAppError } from "./errors"
import { thisMachine, thisMachineId } from "./machines"
import { TASKS_PRESETS_PATH } from "./tasks"
import { withQuery, type Transport } from "./transport"
import type { Capabilities, HarnessInfo } from "./types"
import type { Workspaces } from "./workspaces"
import type { BootstrapDeclaration } from "./wire/placements"
import { accountFromWire } from "./wire/accounts"
import { MACHINE_LOGINS_PATH, machineLoginsFromWire, type MachineLogin } from "./wire/machine-logins"
import { connectedProvidersFromWire, PROVIDERS_PATH } from "./wire/providers"

export type CapabilitiesOwner = {
  readonly value: Accessor<Capabilities | undefined>
  readonly load: () => Promise<void>
}

type Read<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string }
type Availability = { readonly available: boolean; readonly reason?: string }
type Sources = {
  readonly stored: Read<ReadonlySet<string>>
  readonly pi: Read<readonly string[]>
  readonly logins?: Read<readonly MachineLogin[]>
}

const CREDENTIALS_PATH = "/api/claxedo/credentials"
const MACHINE_LOGINS_UNSUPPORTED = 501
const GOAL_MODES: Readonly<Record<string, HarnessInfo["goalMode"]>> = { claude: "evaluated", codex: "native" }
const CLI_PROVIDERS = HARNESS_TABLE as Readonly<Record<string, { readonly label: string; readonly providerIds: readonly string[] } | undefined>>

async function settle<T>(what: string, read: Promise<T>): Promise<Read<T>> {
  try {
    return { ok: true, value: await read }
  } catch (error) {
    const failure = toAppError(error)
    console.error(`${what} could not be read`, failure)
    return { ok: false, reason: failure.message }
  }
}

function harnessInfo(id: string, availability: Availability): HarnessInfo {
  return {
    id,
    name: CLI_PROVIDERS[id]?.label ?? id.charAt(0).toUpperCase() + id.slice(1),
    available: availability.available,
    ...(availability.reason ? { unavailableReason: availability.reason } : {}),
    models: [],
    efforts: [...HARNESS_EFFORT_LEVELS],
    permissionModes: [],
    goalMode: GOAL_MODES[id] ?? "none",
  }
}

async function machineLogins(transport: Transport): Promise<readonly MachineLogin[]> {
  const response = await transport.request(MACHINE_LOGINS_PATH)
  if (response.status === MACHINE_LOGINS_UNSUPPORTED) return []
  if (!response.ok) throw await responseError(response, "Machine logins")
  return machineLoginsFromWire(await response.json())
}

async function storedProviders(transport: Transport): Promise<ReadonlySet<string>> {
  const body = await transport.json<{ credentials?: unknown }>(CREDENTIALS_PATH)
  const accounts = (Array.isArray(body.credentials) ? body.credentials : []).flatMap((row) => accountFromWire(row) ?? [])
  return new Set(accounts.filter((account) => account.active).map((account) => account.providerId))
}

async function piConnected(transport: Transport): Promise<readonly string[]> {
  return connectedProvidersFromWire(await transport.json<unknown>(withQuery(PROVIDERS_PATH, { nativeHarness: "pi" })))
}

function cliAvailability(id: string, sources: Sources): Availability {
  const stored = sources.stored.ok ? sources.stored.value : new Set<string>()
  if ((CLI_PROVIDERS[id]?.providerIds ?? []).some((provider) => stored.has(provider))) return { available: true }
  if (!sources.logins) return { available: false, reason: `Checking this machine's ${id} login` }
  if (!sources.logins.ok) return { available: false, reason: sources.logins.reason }
  const login = sources.logins.value.find((row) => row.harness === id)
  if (!login) return { available: false, reason: `This server reports no ${id} login` }
  if (login.signedIn || login.providerIds.some((provider) => stored.has(provider))) return { available: true }
  return { available: false, reason: `${id} is signed out` }
}

function harnessesFrom(sources: Sources, loopback: boolean): readonly HarnessInfo[] {
  return AGENT_HARNESS_IDS.map((id) => {
    if (id === "opencode") return harnessInfo(id, loopback ? { available: true } : { available: false, reason: "OpenCode runs on a machine" })
    if (id !== "pi") return harnessInfo(id, cliAvailability(id, sources))
    if (!sources.pi.ok) return harnessInfo(id, { available: false, reason: sources.pi.reason })
    return harnessInfo(id, sources.pi.value.length > 0 ? { available: true } : { available: false, reason: "No provider is connected for pi" })
  })
}

function capabilitiesOf(declaration: BootstrapDeclaration, loopback: boolean, harnesses: readonly HarnessInfo[], features: { readonly tasks: boolean; readonly documents: boolean }): Capabilities {
  const signedIn = declaration.issuesSessions
  const machine = thisMachine(declaration, loopback)
  return {
    principal: { kind: "machine", machineId: thisMachineId(declaration) },
    signedIn,
    ...(machine ? { thisMachine: machine } : {}),
    harnesses,
    features: { ...features, cloud: signedIn, remoteAccess: loopback, marketplace: true, terminals: loopback, browser: loopback, sharing: signedIn, livePlugins: loopback },
  }
}

export function createCapabilities(transport: Transport, workspaces: Workspaces): CapabilitiesOwner {
  const [value, setValue] = createSignal<Capabilities | undefined>(undefined)
  const load = async () => {
    const declaration = (await workspaces.load()).declaration
    const logins = settle("Machine logins", machineLogins(transport))
    const [stored, pi, tasks, documents] = await Promise.all([
      settle("Stored credentials", storedProviders(transport)),
      settle("The pi provider catalog", piConnected(transport)),
      settle("Tasks", probeAvailability(transport, TASKS_PRESETS_PATH)),
      settle("Documents", probeAvailability(transport, DOCUMENTS_PATH)),
    ])
    const features = { tasks: tasks.ok && tasks.value.kind === "available", documents: documents.ok && documents.value.kind === "available" }
    setValue(capabilitiesOf(declaration, transport.loopback, harnessesFrom({ stored, pi }, transport.loopback), features))
    const read = await logins
    setValue(capabilitiesOf(declaration, transport.loopback, harnessesFrom({ stored, pi, logins: read }, transport.loopback), features))
  }
  return { value, load }
}
