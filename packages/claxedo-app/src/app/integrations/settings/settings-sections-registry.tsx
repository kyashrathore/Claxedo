import { createHarnessConnectionsCatalog } from "@/platform/query/connection-catalog"
import { authFetch, getClaxedoServerUrl } from "@/platform/api/api"
import { createMemo, onMount, type JSX } from "solid-js"
import { useLanguage } from "@/platform/i18n/provider"
import { SettingsGeneral } from "@/features/settings/ui/general"
import { SettingsKeybinds } from "@/features/settings/ui/keybinds"
import { SettingsMachines } from "@/app/integrations/settings/machines-section"
import { SettingsModels } from "@/features/settings/ui/models"
import { SettingsTerminals } from "@/features/settings/ui/terminals"
import { SettingsConnections } from "@/features/settings/ui/connections"
import { SandboxSettingsSection } from "@/features/settings/ui/sandbox-section"
import { OrgTeamSettingsSection } from "@/features/settings/ui/org-team-section"
import { useConfigOptional } from "@/app/providers/config"
import { resolveProductUiFlags } from "@/app/composition/product-ui-flags"
import { useSettingsScope } from "@/features/settings/scope/settings-scope"
import { settingsSections } from "@/app/integrations/settings-sections"
import type { SettingsSection } from "@/app/integrations/registry"
import type { ClaxedoIconName } from "@/ui/controls/claxedo-icon"

export type SettingsSectionEntry = {
  id: string
  label: string
  icon: ClaxedoIconName
  group: SettingsSection
  /**
   * What the panel says about itself, for the sections that say nothing.
   * General and Models open with their own title and blurb; the rest were
   * written as panels inside a tab and start straight at their first control,
   * so the surface gives them the same opening the others have.
   */
  heading?: { title: string; description?: string }
  render: () => JSX.Element
}

/**
 * Every settings section that exists for this build and this workspace, with
 * the panel each one draws.
 *
 * One owner for both halves: the nav lists these and the content renders the
 * one that is open, so a section cannot be offered and then have nothing
 * behind it — which is what two lists of the same thing eventually produce.
 */
export function useSettingsSectionRegistry() {
  const language = useLanguage()
  const config = useConfigOptional()
  const productUi = createMemo(() => resolveProductUiFlags(config))
  const scope = useSettingsScope()
  const agentConnections = createHarnessConnectionsCatalog({ base: getClaxedoServerUrl(), request: authFetch })
  onMount(() => void agentConnections.refresh())
  const showConnections = createMemo(() => {
    const catalog = agentConnections.data()
    return productUi().settingsConnections || (catalog?.status === "supported" && catalog.connections.length > 0)
  })
  const contributed = createMemo(() => settingsSections({ workspaceId: scope.workspace()?.workspaceId }))

  return createMemo<SettingsSectionEntry[]>(() => {
    const inGroup = (group: SettingsSection) =>
      contributed()
        .filter((entry) => entry.section === group)
        .map((entry) => ({
          id: entry.id,
          label: entry.label,
          icon: entry.icon ?? "sliders",
          group,
          // No heading supplied: a contributed section draws its own surface,
          // and the one it draws already opens with its name.
          render: () => entry.renderer(),
        }))

    return [
      { id: "general", label: language.t("settings.tab.general"), icon: "sliders" as const, group: "desktop" as const, render: () => <SettingsGeneral /> },
      { id: "shortcuts", label: language.t("settings.tab.shortcuts"), icon: "keyboard" as const, group: "desktop" as const, render: () => <SettingsKeybinds /> },
      { id: "terminals", label: "Terminals", icon: "terminal" as const, group: "desktop" as const, render: () => <SettingsTerminals /> },
      {
        id: "devices",
        label: "Machines",
        icon: "link" as const,
        group: "desktop" as const,
        heading: { title: "Machines", description: "The computers this account can reach, and what each one serves." },
        render: () => <SettingsMachines />,
      },
      {
        id: "orgs",
        label: "Orgs & Teams",
        icon: "folders" as const,
        group: "desktop" as const,
        heading: { title: "Orgs & Teams", description: "The organizations you belong to and the teams inside them." },
        render: () => <OrgTeamSettingsSection />,
      },
      ...inGroup("desktop"),
      {
        id: "models",
        label: language.t("settings.models.title"),
        icon: "models" as const,
        group: "workspace" as const,
        heading: { title: language.t("settings.models.title"), description: language.t("settings.models.description") },
        render: () => <SettingsModels />,
      },
      ...inGroup("workspace"),
      ...(showConnections()
        ? [{
            id: "connections",
            label: "Connections",
            icon: "link" as const,
            group: "account" as const,
            heading: { title: "Connections", description: "The services this account is connected to." },
            render: () => (
              <SettingsConnections agentConnections={agentConnections} integrations={productUi().settingsConnections} />
            ),
          }]
        : []),
      ...(productUi().settingsSandboxProviders
        ? [{
            id: "compute",
            label: "Sandbox",
            icon: "cloud-upload" as const,
            group: "account" as const,
            heading: { title: "Sandbox", description: "Where sandboxed workspaces run." },
            render: () => <SandboxSettingsSection />,
          }]
        : []),
      ...inGroup("account"),
    ]
  })
}
