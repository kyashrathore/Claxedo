import { authRoutes } from "@/auth"
import { onboardingRoute } from "@/onboarding"
import { pluginsSettingsSection } from "@/plugins"
import { addProjectPage, projectsSettingsSection } from "@/projects"
import { settingsSections } from "@/settings"
import { draftSessionPaneKind, sessionPaneKind } from "@/session/view"
import { terminalPaneKind } from "@/terminal"
import type { FirstPartyEntries } from "./registries"
import { settingsPage } from "./view/settings-page"

export const firstParty: FirstPartyEntries = {
  pages: [settingsPage, addProjectPage],
  paneKinds: [sessionPaneKind, draftSessionPaneKind, terminalPaneKind],
  panelViews: [],
  settingsSections: [...settingsSections, projectsSettingsSection, pluginsSettingsSection],
  sidebarItems: [],
  overlays: [],
  commands: [],
  mentions: [],
  themes: [],
  iconSkins: [],
  routes: [onboardingRoute, ...authRoutes],
}
