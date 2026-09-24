import { modelsSettingsSection } from "@/accounts"
import { authRoutes } from "@/auth"
import { pluginsSettingsSection } from "@/plugins"
import { projectsSettingsSection } from "@/projects"
import { marketplacePage, tasksPage } from "@/rail"
import { settingsSections } from "@/settings"
import { draftSessionPaneKind, sessionPaneKind, subagentPanelView } from "@/session/view"
import { terminalCreatorPaneKind, terminalPaneKind } from "@/terminal"
import type { FirstPartyEntries } from "./registries"
import { pageTabPaneKind } from "./view/page-tab"
import { settingsPage } from "./view/settings-page"

export const firstParty: FirstPartyEntries = {
  pages: [settingsPage, tasksPage, marketplacePage],
  paneKinds: [sessionPaneKind, draftSessionPaneKind, terminalPaneKind, terminalCreatorPaneKind, pageTabPaneKind],
  panelViews: [subagentPanelView],
  settingsSections: [...settingsSections, modelsSettingsSection, projectsSettingsSection, pluginsSettingsSection],
  sidebarItems: [],
  overlays: [],
  commands: [],
  mentions: [],
  themes: [],
  iconSkins: [],
  routes: [...authRoutes],
}
