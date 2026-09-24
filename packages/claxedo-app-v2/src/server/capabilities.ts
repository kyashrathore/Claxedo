import { HARNESS_EFFORT_LEVELS, HARNESS_TABLE } from "@claxedo/agent-runtime-contract"
import { createSignal, type Accessor } from "solid-js"
import { probeAvailability } from "./availability"
import { DOCUMENTS_PATH } from "./documents"
import { machineId } from "./ids"
import { TASKS_PRESETS_PATH } from "./tasks"
import type { Transport } from "./transport"
import type { Capabilities, HarnessInfo, Machine, ModelChoice } from "./types"
import type { Workspaces } from "./workspaces"
import type { BootstrapDeclaration } from "./wire/placements"
import { providerModelsFromWire } from "./wire/providers"

export type CapabilitiesOwner = {
  readonly value: Accessor<Capabilities | undefined>
  readonly load: () => Promise<void>
}

const PROVIDERS_PATH = "/api/claxedo/agent-config/providers"

const HARNESSES: readonly { readonly id: string; readonly goalMode: HarnessInfo["goalMode"]; readonly catalog: boolean }[] = [
  { id: "claude", goalMode: "evaluated", catalog: false },
  { id: "codex", goalMode: "native", catalog: false },
  { id: "cursor", goalMode: "none", catalog: false },
  { id: "pi", goalMode: "none", catalog: true },
  { id: "opencode", goalMode: "none", catalog: true },
]

function labelOf(id: string) {
  const entry = (HARNESS_TABLE as Readonly<Record<string, { readonly label: string } | undefined>>)[id]
  return entry?.label ?? id.charAt(0).toUpperCase() + id.slice(1)
}

async function catalogModels(transport: Transport, harness: string): Promise<readonly ModelChoice[]> {
  const url = `${PROVIDERS_PATH}?nativeHarness=${encodeURIComponent(harness)}`
  return providerModelsFromWire(await transport.json<unknown>(url))
}

async function harnessInfo(transport: Transport, harness: (typeof HARNESSES)[number]): Promise<HarnessInfo> {
  const models = harness.catalog ? await catalogModels(transport, harness.id) : []
  return {
    id: harness.id,
    name: labelOf(harness.id),
    available: !harness.catalog || models.length > 0,
    models,
    efforts: [...HARNESS_EFFORT_LEVELS],
    permissionModes: [],
    goalMode: harness.goalMode,
  }
}

function thisMachine(declaration: BootstrapDeclaration): Machine | undefined {
  if (!declaration.enrollmentId) return undefined
  return { id: machineId(declaration.enrollmentId), name: "This machine", online: true, isThisMachine: true }
}

export function createCapabilities(transport: Transport, workspaces: Workspaces): CapabilitiesOwner {
  const [value, setValue] = createSignal<Capabilities | undefined>(undefined)
  const load = async () => {
    const declaration = (await workspaces.load()).declaration
    const [harnesses, tasks, documents] = await Promise.all([
      Promise.all(HARNESSES.map((harness) => harnessInfo(transport, harness))),
      probeAvailability(transport, TASKS_PRESETS_PATH),
      probeAvailability(transport, DOCUMENTS_PATH),
    ])
    const signedIn = declaration.issuesSessions
    const machine = thisMachine(declaration)
    setValue({
      principal: { kind: "machine", machineId: machineId(declaration.enrollmentId ?? "this-machine") },
      signedIn,
      ...(machine ? { thisMachine: machine } : {}),
      harnesses,
      features: {
        tasks: tasks.kind === "available",
        documents: documents.kind === "available",
        cloud: signedIn,
        remoteAccess: transport.loopback,
        marketplace: true,
        terminals: transport.loopback,
        browser: transport.loopback,
        sharing: signedIn,
        livePlugins: transport.loopback,
      },
    })
  }
  return { value, load }
}
