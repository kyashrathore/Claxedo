import { createContext, createMemo, createSignal, useContext, type Accessor, type ParentProps } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { NATIVE_HARNESS_IDS, harnessSelectionKey, isCatalogHarnessId, nativeHarness, connectionHarness, type HarnessSelection, type NativeHarnessId } from "@/platform/identity/harness-selection"
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
  selection: HarnessSelection
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
  harnessSelection: Accessor<HarnessSelection | undefined>
  nativeHarness: Accessor<NativeHarnessId | undefined>
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
 * The catalog reads, the provider-auth writes and the dialogs these surfaces
 * open all carry `scopeRef` and the selected harness, so the two pickers are
 * the only place the question "which machine, which harness" is answered here.
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
    ...NATIVE_HARNESS_IDS.map((id) => {
      const selection = nativeHarness(id)
      return { id: harnessSelectionKey(selection), label: harnessDisplayLabel(id), selection }
    }),
    ...acp().map((row) => {
      const selection = connectionHarness(row.key)
      return { id: harnessSelectionKey(selection), label: row.label, selection }
    }),
  ])
  const selectedOption = createMemo(() => {
    const selected = selectedHarness()
    const explicit = harnesses().find((option) => option.id === selected)
    if (explicit) return explicit
    const current = workspace()
    const remembered = current
      ? readWorkspaceHarnessDefault({ serverUrl: getClaxedoServerUrl(), workspaceKey: current.key })
      : undefined
    // A remembered harness that is no longer offered stays unselected: pointing
    // these surfaces at a different harness would write credentials somewhere
    // the workspace never chose.
    if (remembered) return harnesses().find((option) => option.id === harnessSelectionKey(remembered))
    // With nothing remembered the question is unanswered, not answered blank,
    // and both surfaces plus the picker naming them would render empty. A
    // catalog harness is the one with a provider list to show.
    const offered = harnesses()
    return offered.find((option) => option.selection.kind === "native" && isCatalogHarnessId(option.selection.harnessId))
      ?? offered[0]
  })
  const harnessSelection = () => selectedOption()?.selection

  const value: SettingsScope = {
    workspaces,
    loading: () => catalog.isPending,
    workspace,
    selectWorkspace: setSelectedWorkspace,
    harnesses,
    harness: () => selectedOption()?.id ?? "",
    harnessSelection,
    nativeHarness: () => {
      const selection = harnessSelection()
      return selection?.kind === "native" ? selection.harnessId : undefined
    },
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
