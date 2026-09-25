import { AGENT_HARNESS_IDS, HARNESS_EFFORT_LEVELS, HARNESS_TABLE } from "@claxedo/agent-runtime-contract"
import { createSignal, type Accessor } from "solid-js"
import { thisMachine, thisMachineId } from "./machines"
import type { Transport } from "./transport"
import type { Capabilities, HarnessInfo } from "./types"
import type { Workspaces } from "./workspaces"
import type { BootstrapDeclaration } from "./wire/placements"

export type CapabilitiesOwner = {
  readonly value: Accessor<Capabilities | undefined>
  readonly load: () => Promise<void>
}

type Availability = { readonly available: boolean; readonly reason?: string }

const GOAL_MODES: Readonly<Record<string, HarnessInfo["goalMode"]>> = { claude: "evaluated", codex: "native", cursor: "native", pi: "evaluated" }
const HARNESS_LABELS = HARNESS_TABLE as Readonly<Record<string, { readonly label: string } | undefined>>

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

function harnessesFrom(loopback: boolean): readonly HarnessInfo[] {
  return AGENT_HARNESS_IDS.map((id) => harnessInfo(id, loopback ? { available: true } : { available: false, reason: `${id} runs on a machine` }))
}

function capabilitiesOf(declaration: BootstrapDeclaration, loopback: boolean): Capabilities {
  const signedIn = declaration.issuesSessions
  const machine = thisMachine(declaration, loopback)
  return {
    principal: { kind: "machine", machineId: thisMachineId(declaration) },
    signedIn,
    ...(machine ? { thisMachine: machine } : {}),
    harnesses: harnessesFrom(loopback),
    features: { documents: declaration.documents, cloud: signedIn, remoteAccess: loopback, marketplace: true, terminals: loopback, browser: loopback, sharing: signedIn, livePlugins: loopback },
  }
}

export function createCapabilities(transport: Transport, workspaces: Workspaces): CapabilitiesOwner {
  const [value, setValue] = createSignal<Capabilities | undefined>(undefined)
  const load = async () => {
    const declaration = (await workspaces.load()).declaration
    setValue(capabilitiesOf(declaration, transport.loopback))
  }
  return { value, load }
}
