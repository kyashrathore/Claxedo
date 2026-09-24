import { AGENT_HARNESS_IDS, HARNESS_EFFORT_LEVELS, HARNESS_TABLE } from "@claxedo/agent-runtime-contract"
import { createSignal, type Accessor } from "solid-js"
import { probeAvailability } from "./availability"
import { DOCUMENTS_PATH } from "./documents"
import { responseError } from "./errors"
import { thisMachine, thisMachineId } from "./machines"
import { TASKS_PRESETS_PATH } from "./tasks"
import { withQuery, type Transport } from "./transport"
import type { Capabilities, HarnessInfo, ModelChoice } from "./types"
import type { Workspaces } from "./workspaces"
import { accountFromWire } from "./wire/accounts"
import { MACHINE_LOGINS_PATH, machineLoginsFromWire, type MachineLogin } from "./wire/machine-logins"
import { providerCatalogFromWire } from "./wire/providers"

export type CapabilitiesOwner = {
  readonly value: Accessor<Capabilities | undefined>
  readonly load: () => Promise<void>
}

const PROVIDERS_PATH = "/api/claxedo/agent-config/providers"
const CREDENTIALS_PATH = "/api/claxedo/credentials"
const MACHINE_LOGINS_UNSUPPORTED = 501
const CATALOG_HARNESSES: readonly string[] = ["pi", "opencode"]
const GOAL_MODES: Readonly<Record<string, HarnessInfo["goalMode"]>> = { claude: "evaluated", codex: "native" }

function harnessInfo(id: string, available: boolean, models: readonly ModelChoice[]): HarnessInfo {
  const entry = (HARNESS_TABLE as Readonly<Record<string, { readonly label: string } | undefined>>)[id]
  return {
    id,
    name: entry?.label ?? id.charAt(0).toUpperCase() + id.slice(1),
    available,
    models,
    efforts: [...HARNESS_EFFORT_LEVELS],
    permissionModes: [],
    goalMode: GOAL_MODES[id] ?? "none",
  }
}

async function catalogHarness(transport: Transport, id: string): Promise<HarnessInfo> {
  const catalog = providerCatalogFromWire(await transport.json<unknown>(withQuery(PROVIDERS_PATH, { nativeHarness: id })))
  return harnessInfo(id, catalog.connected.length > 0, catalog.models)
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

async function readHarnesses(transport: Transport): Promise<readonly HarnessInfo[]> {
  const [logins, stored, catalogs] = await Promise.all([
    machineLogins(transport),
    storedProviders(transport),
    Promise.all(CATALOG_HARNESSES.map((id) => catalogHarness(transport, id))),
  ])
  return AGENT_HARNESS_IDS.map((id) => {
    const catalog = catalogs.find((harness) => harness.id === id)
    if (catalog) return catalog
    const login = logins.find((row) => row.harness === id)
    return harnessInfo(id, !!login && (login.signedIn || login.providerIds.some((provider) => stored.has(provider))), [])
  })
}

export function createCapabilities(transport: Transport, workspaces: Workspaces): CapabilitiesOwner {
  const [value, setValue] = createSignal<Capabilities | undefined>(undefined)
  const load = async () => {
    const declaration = (await workspaces.load()).declaration
    const [harnesses, tasks, documents] = await Promise.all([
      readHarnesses(transport),
      probeAvailability(transport, TASKS_PRESETS_PATH),
      probeAvailability(transport, DOCUMENTS_PATH),
    ])
    const signedIn = declaration.issuesSessions
    const machine = thisMachine(declaration, transport.loopback)
    setValue({
      principal: { kind: "machine", machineId: thisMachineId(declaration) },
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
