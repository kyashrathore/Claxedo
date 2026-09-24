import { browserPanelTab } from "@/browser"
import { filePaneKind, filesPanelTab } from "@/files"
import { onboardingRoute } from "@/onboarding"
import { addProjectPage, projectPage } from "@/projects"
import { changesPanelTab } from "@/review"
import { sessionPaneKind } from "./placeholders/session-pane"
import type { FirstPartyEntries } from "./registries"
import { settingsPage } from "./view/settings-page"

export const firstParty: FirstPartyEntries = {
  pages: [settingsPage, projectPage, addProjectPage],
  paneKinds: [sessionPaneKind, filePaneKind],
  panelTabs: [filesPanelTab, changesPanelTab, browserPanelTab],
  settingsSections: [],
  sidebarItems: [],
  overlays: [],
  commands: [],
  mentions: [],
  themes: [],
  iconSkins: [],
  routes: [onboardingRoute],
}
