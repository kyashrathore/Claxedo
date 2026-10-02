import { modelsSettingsSection } from "@/accounts"
import { authRoutes } from "@/auth"
import { onboardingRoute } from "@/onboarding"
import { pluginsSettingsSection } from "@/plugins"
import { projectsSettingsSection } from "@/projects"
import { marketplacePage, tasksPage } from "@/rail"
import { settingsSections } from "@/settings"
import { presetsSettingsSection } from "@/tasks"
import { draftSessionPaneKind, sessionPaneKind, subagentPanelView } from "@/session"
import { terminalCreatorPaneKind, terminalPaneKind } from "@/terminal"
import { pageTabPaneKind, paneKindEntry, settingsPage, type FirstPartyEntries } from "@/shell"

export const firstParty: FirstPartyEntries = {
  pages: [settingsPage, tasksPage, marketplacePage],
  paneKinds: [
    paneKindEntry(sessionPaneKind),
    paneKindEntry(draftSessionPaneKind),
    paneKindEntry(terminalPaneKind),
    paneKindEntry(terminalCreatorPaneKind),
    paneKindEntry(pageTabPaneKind),
  ],
  panelViews: [subagentPanelView],
  settingsSections: [...settingsSections, modelsSettingsSection, projectsSettingsSection, pluginsSettingsSection, presetsSettingsSection],
  sidebarItems: [],
  overlays: [],
  commands: [],
  mentions: [],
  themes: [],
  iconSkins: [],
  routes: [onboardingRoute, ...authRoutes],
}
