import { authRoutes } from "@/auth"
import { onboardingRoute } from "@/onboarding"
import { pluginsSettingsSection } from "@/plugins"
import { projectsSettingsSection } from "@/projects"
import { settingsSections } from "@/settings"
import { draftSessionPaneKind, sessionPaneKind } from "@/session/view"
import { terminalCreatorPaneKind, terminalPaneKind } from "@/terminal"
import type { FirstPartyEntries } from "./registries"
import { settingsPage } from "./view/settings-page"

export const firstParty: FirstPartyEntries = {
  pages: [settingsPage],
  paneKinds: [sessionPaneKind, draftSessionPaneKind, terminalPaneKind, terminalCreatorPaneKind],
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
