import { createContext, createMemo, createSignal, useContext, type Accessor, type ParentProps } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { BUILTIN_HARNESS_IDS, DEFAULT_HARNESS_ID } from "@/platform/identity/session-ref"
import { harnessDisplayLabel } from "@/ui/harness-display"
import { getClaxedoServerUrl } from "@/platform/api/api"
import {
  readWorkspaceHarnessDefault,
  useEnabledAcpHarnesses,
  useSDK,
  useShellQueryOptions,
} from "@/features/settings/app-ports"
import {
  resolveSettingsWorkspace,
  settingsWorkspaceOptions,
  type SettingsWorkspaceOption,
} from "./settings-scope-options"

export type SettingsHarnessOption = {
  id: string
  label: string
}

export type SettingsScope = {
  /** Every workspace this principal can configure, from the workspace catalog. */
  workspaces: Accessor<SettingsWorkspaceOption[]>
  /** Whether the catalog has answered yet. */
  loading: Accessor<boolean>
  workspace: Accessor<SettingsWorkspaceOption | undefined>
  selectWorkspace: (key: string) => void
  /** The harnesses offerable for the selected workspace. */
  harnesses: Accessor<SettingsHarnessOption[]>
  harness: Accessor<string>
  selectHarness: (id: string) => void
  /** The scope string catalog and provider-auth reads are keyed by. */
  scopeRef: Accessor<string | undefined>
  /** The persistence bucket for the selected workspace's model store. */
  workspaceKey: Accessor<string>
  serverUrl: Accessor<string>
}

const SettingsScopeContext = createContext<SettingsScope>()

/**
 * The workspace this dialog opened over, when it opened over one.
 *
 * Same probe `useProviders` uses: inside a pane's SDK scope the focused
 * workspace is the one on screen, and outside one there is no focus to inherit.
 */
function focusedWorkspace() {
  try {
    const sdk = useSDK()
    return { workspaceId: sdk.workspaceId, directory: sdk.directory }
  } catch {
    return undefined
  }
}

/**
 * Settings' explicit (workspace, harness) selection.
 *
 * Providers, provider auth, the connect flows, the custom-provider dialog and
 * the model store all read under it, so the two pickers are the only place the
 * question "which machine, which harness" is answered on these surfaces.
 */
export function SettingsScopeProvider(props: ParentProps) {
  const queryOptions = useShellQueryOptions()
  const catalog = useQuery(() => queryOptions.projects())
  const focused = focusedWorkspace()
  const acp = useEnabledAcpHarnesses()

  const [selectedWorkspace, setSelectedWorkspace] = createSignal<string | undefined>()
  const [selectedHarness, setSelectedHarness] = createSignal<string | undefined>()

  const workspaces = createMemo(() => settingsWorkspaceOptions(catalog.data ?? []))
  const workspace = createMemo(() =>
    resolveSettingsWorkspace({ options: workspaces(), selected: selectedWorkspace(), focused }))

  const harnesses = createMemo<SettingsHarnessOption[]>(() => [
    ...BUILTIN_HARNESS_IDS.map((id) => ({ id: id as string, label: harnessDisplayLabel(id) })),
    ...acp().map((row) => ({ id: row.key, label: row.label })),
  ])
  // Unselected, the surface opens on the harness this workspace was last used
  // with — the same record a new draft in it opens on — and, with no history,
  // on the same product default a new draft opens on. Settings and a pane on
  // one workspace therefore name one harness between them, and edit one half of
  // its per-harness model store.
  const harness = createMemo(() => {
    const selected = selectedHarness()
    if (selected && harnesses().some((option) => option.id === selected)) return selected
    const current = workspace()
    const remembered = current
      ? readWorkspaceHarnessDefault({ serverUrl: getClaxedoServerUrl(), workspaceKey: current.key })
      : undefined
    if (remembered && harnesses().some((option) => option.id === remembered)) return remembered
    return DEFAULT_HARNESS_ID
  })

  const value: SettingsScope = {
    workspaces,
    loading: () => catalog.isPending,
    workspace,
    selectWorkspace: setSelectedWorkspace,
    harnesses,
    harness,
    selectHarness: setSelectedHarness,
    scopeRef: () => workspace()?.scope,
    workspaceKey: () => workspace()?.key ?? "",
    serverUrl: () => getClaxedoServerUrl(),
  }

  return <SettingsScopeContext.Provider value={value}>{props.children}</SettingsScopeContext.Provider>
}

export function useSettingsScope() {
  const value = useContext(SettingsScopeContext)
  if (!value) throw new Error("useSettingsScope must be used within SettingsScopeProvider")
  return value
}
