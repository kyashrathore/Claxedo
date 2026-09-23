import { HARNESS_EFFORT_LEVELS, HARNESS_TABLE } from "@claxedo/agent-runtime-contract"
import type { QueryClient } from "@tanstack/solid-query"
import { createSignal, type Accessor } from "solid-js"
import { listProviders, type ProviderList } from "./accounts"
import { machineId, userId } from "./ids"
import { probeAvailability, TASKS_PATH } from "./tasks"
import { DOCUMENTS_PATH } from "./documents"
import type { Transport } from "./transport"
import type { Capabilities, HarnessInfo, Machine, ModelChoice, Principal } from "./types"
import type { Workspaces } from "./workspaces"
import type { BootstrapDeclaration } from "./wire/placements"

export type CapabilitiesOwner = {
  readonly value: Accessor<Capabilities | undefined>
  readonly load: () => Promise<void>
}

const HARNESSES = [
  { id: "claude", goalMode: "evaluated" as const },
  { id: "codex", goalMode: "native" as const },
  { id: "cursor", goalMode: "none" as const },
  { id: "pi", goalMode: "none" as const },
  { id: "opencode", goalMode: "none" as const },
] as const

function labelOf(id: string) {
  return (HARNESS_TABLE as Readonly<Record<string, { label: string } | undefined>>)[id]?.label ?? id.charAt(0).toUpperCase() + id.slice(1)
}

function modelsOf(providers: ProviderList): ModelChoice[] {
  const choices: ModelChoice[] = []
  for (const provider of providers.all) {
    for (const model of Object.values(provider.models)) {
      if (!model.connected) continue
      choices.push({ providerId: provider.id, modelId: model.id })
      for (const variant of Object.keys(model.variants ?? {})) choices.push({ providerId: provider.id, modelId: model.id, variant })
    }
  }
  return choices
}

async function harnessInfo(transport: Transport, harness: (typeof HARNESSES)[number]): Promise<HarnessInfo> {
  const providers = await listProviders(transport, harness.id).catch(() => ({ all: [], default: {}, connected: [] }))
  const models = modelsOf(providers)
  return {
    id: harness.id,
    name: labelOf(harness.id),
    available: models.length > 0,
    models,
    efforts: [...HARNESS_EFFORT_LEVELS],
    permissionModes: [],
    goalMode: harness.goalMode,
  }
}

function principalOf(declaration: BootstrapDeclaration | undefined, session: { readonly id?: string; readonly name?: string; readonly email?: string } | undefined): Principal {
  if (session?.id) {
    return { kind: "user", userId: userId(session.id), name: session.name ?? session.email ?? session.id, ...(session.email ? { email: session.email } : {}) }
  }
  return { kind: "machine", machineId: machineId(declaration?.enrollmentId ?? "this-machine") }
}

function thisMachine(declaration: BootstrapDeclaration | undefined): Machine | undefined {
  if (!declaration?.enrollmentId) return undefined
  return { id: machineId(declaration.enrollmentId), name: "This machine", online: true, isThisMachine: true }
}

export function createCapabilities(input: { readonly transport: Transport; readonly workspaces: Workspaces; readonly queryClient: QueryClient }): CapabilitiesOwner {
  const { transport, workspaces } = input
  const [value, setValue] = createSignal<Capabilities | undefined>(undefined)
  const load = async () => {
    const declaration = workspaces.catalog()?.declaration
    const [harnesses, tasks, documents] = await Promise.all([
      Promise.all(HARNESSES.map((harness) => harnessInfo(transport, harness))),
      probeAvailability(transport, `${TASKS_PATH}/presets`),
      probeAvailability(transport, DOCUMENTS_PATH),
    ])
    const signedIn = declaration?.issuesSessions === true
    const machine = thisMachine(declaration)
    setValue({
      principal: principalOf(declaration, undefined),
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
