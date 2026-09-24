import { AGENT_HARNESS_IDS, HARNESS_EFFORT_LEVELS, HARNESS_TABLE } from "@claxedo/agent-runtime-contract"
import { createSignal, type Accessor } from "solid-js"
import { probeAvailability } from "./availability"
import { DOCUMENTS_PATH } from "./documents"
import { toAppError } from "./errors"
import { thisMachine, thisMachineId } from "./machines"
import { TASKS_PRESETS_PATH } from "./tasks"
import { withQuery, type Transport } from "./transport"
import type { Capabilities, HarnessInfo } from "./types"
import type { Workspaces } from "./workspaces"
import type { BootstrapDeclaration } from "./wire/placements"
import { connectedProvidersFromWire, PROVIDERS_PATH } from "./wire/providers"

export type CapabilitiesOwner = {
  readonly value: Accessor<Capabilities | undefined>
  readonly load: () => Promise<void>
}

type Read<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string }
type Availability = { readonly available: boolean; readonly reason?: string }

const GOAL_MODES: Readonly<Record<string, HarnessInfo["goalMode"]>> = { claude: "evaluated", codex: "native", cursor: "native", pi: "evaluated" }
const HARNESS_LABELS = HARNESS_TABLE as Readonly<Record<string, { readonly label: string } | undefined>>

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
    name: HARNESS_LABELS[id]?.label ?? id.charAt(0).toUpperCase() + id.slice(1),
    available: availability.available,
    ...(availability.reason ? { unavailableReason: availability.reason } : {}),
    models: [],
    efforts: [...HARNESS_EFFORT_LEVELS],
    permissionModes: [],
    goalMode: GOAL_MODES[id] ?? "none",
  }
}

async function piConnected(transport: Transport): Promise<readonly string[]> {
  return connectedProvidersFromWire(await transport.json<unknown>(withQuery(PROVIDERS_PATH, { nativeHarness: "pi" })))
}

function harnessesFrom(pi: Read<readonly string[]>, loopback: boolean): readonly HarnessInfo[] {
  return AGENT_HARNESS_IDS.map((id) => {
    if (id !== "pi") return harnessInfo(id, loopback ? { available: true } : { available: false, reason: `${id} runs on a machine` })
    if (!pi.ok) return harnessInfo(id, { available: false, reason: pi.reason })
    return harnessInfo(id, pi.value.length > 0 ? { available: true } : { available: false, reason: "No provider is connected for pi" })
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
    const [pi, tasks, documents] = await Promise.all([
      settle("The pi provider catalog", piConnected(transport)),
      settle("Tasks", probeAvailability(transport, TASKS_PRESETS_PATH)),
      settle("Documents", probeAvailability(transport, DOCUMENTS_PATH)),
    ])
    const features = { tasks: tasks.ok && tasks.value.kind === "available", documents: documents.ok && documents.value.kind === "available" }
    setValue(capabilitiesOf(declaration, transport.loopback, harnessesFrom(pi, transport.loopback), features))
  }
  return { value, load }
}
