import { AGENT_HARNESS_IDS, HARNESS_EFFORT_LEVELS, HARNESS_TABLE } from "@claxedo/agent-runtime-contract"
import { createSignal, type Accessor } from "solid-js"
import { machineId } from "./ids"
import type { Capabilities, HarnessInfo } from "./types"
import type { Workspaces } from "./workspaces"
import type { BootstrapDeclaration } from "./wire/placements"

export type CapabilitiesOwner = {
  readonly value: Accessor<Capabilities | undefined>
  readonly load: () => Promise<void>
}

const GOAL_MODES: Readonly<Record<string, HarnessInfo["goalMode"]>> = { claude: "evaluated", codex: "native", cursor: "native", pi: "evaluated" }
const HARNESS_LABELS = HARNESS_TABLE as Readonly<Record<string, { readonly label: string } | undefined>>

function harnessInfo(id: string): HarnessInfo {
  return {
    id,
    name: HARNESS_LABELS[id]?.label ?? id.charAt(0).toUpperCase() + id.slice(1),
    models: [],
    efforts: [...HARNESS_EFFORT_LEVELS],
    goalMode: GOAL_MODES[id] ?? "none",
  }
}

export function servesFromMachine(declaration: BootstrapDeclaration): boolean {
  return declaration.serverKind === "daemon"
}

function capabilitiesFromDeclaration(declaration: BootstrapDeclaration): Capabilities {
  const signedIn = declaration.issuesSessions
  const localExecution = servesFromMachine(declaration)
  return {
    principal: { kind: "machine", ...(declaration.enrollmentId ? { machineId: machineId(declaration.enrollmentId) } : {}) },
    signedIn,
    localExecution,
    harnesses: AGENT_HARNESS_IDS.map(harnessInfo),
    features: { documents: declaration.documents, connections: declaration.connections, cloud: signedIn, livePlugins: localExecution },
  }
}

export function createCapabilities(workspaces: Workspaces): CapabilitiesOwner {
  const [value, setValue] = createSignal<Capabilities | undefined>(undefined)
  const load = async () => {
    setValue(capabilitiesFromDeclaration((await workspaces.load()).declaration))
  }
  return { value, load }
}
