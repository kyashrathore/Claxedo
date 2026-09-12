import { createContext, createMemo, useContext, type Accessor, type ParentProps } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { NATIVE_HARNESS_IDS, harnessSelectionKey, nativeHarness, connectionHarness, type HarnessSelection } from "@/platform/identity/harness-selection"
import { harnessDisplayLabel } from "@/ui/harness-display"
import { getClaxedoServerUrl } from "@/platform/api/api"
import { useEnabledAcpHarnesses, useSDK, useShellQueryOptions } from "@/features/settings/app-ports"
import {
  resolveSettingsWorkspace,
  settingsWorkspaceOptions,
  type SettingsWorkspaceOption,
} from "./settings-scope-options"

export type SettingsHarnessOption = {
  id: string
  /** A DOM-safe name for the harness: its id, or `connection:<id>` for an ACP connection. */
  slug: string
  label: string
  selection: HarnessSelection
}

export type SettingsScope = {
  /** Every workspace this principal can configure, from the workspace catalog. */
  workspaces: Accessor<SettingsWorkspaceOption[]>
  /** Whether the catalog has answered yet. */
  loading: Accessor<boolean>
  /** The workspace in view, else the catalog's first: the machine every read here asks. */
  workspace: Accessor<SettingsWorkspaceOption | undefined>
  /** Every harness offerable on this server: the built-in five plus enabled ACP connections. */
  harnesses: Accessor<SettingsHarnessOption[]>
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
 * The machine Settings asks and the harnesses it lists.
 *
 * Catalog reads and provider-auth writes carry `scopeRef`, so this is the one
 * place "which machine" is answered: the workspace in view, else the first the
 * catalog knows. Nothing here is a user choice; the surfaces list every harness.
 */
export function SettingsScopeProvider(props: ParentProps) {
  const queryOptions = useShellQueryOptions()
  const catalog = useQuery(() => queryOptions.projects())
  const focused = focusedWorkspace()
  const acp = useEnabledAcpHarnesses()

  const workspaces = createMemo(() => settingsWorkspaceOptions(catalog.data ?? []))
  const workspace = createMemo(() => resolveSettingsWorkspace({ options: workspaces(), focused }))

  const harnesses = createMemo<SettingsHarnessOption[]>(() => [
    ...NATIVE_HARNESS_IDS.map((id) => {
      const selection = nativeHarness(id)
      return { id: harnessSelectionKey(selection), slug: id, label: harnessDisplayLabel(id), selection }
    }),
    ...acp().map((row) => {
      const selection = connectionHarness(row.key)
      return { id: harnessSelectionKey(selection), slug: `connection:${row.key}`, label: row.label, selection }
    }),
  ])

  const value: SettingsScope = {
    workspaces,
    loading: () => catalog.isPending,
    workspace,
    harnesses,
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
