import { browserPanelTab } from "@/browser"
import { filePaneKind, filesPanelTab } from "@/files"
import { onboardingRoute } from "@/onboarding"
import { addProjectPage, projectPage } from "@/projects"
import { changesPanelTab } from "@/review"
import { draftSessionPaneKind, sessionPaneKind } from "@/session/view"
import { terminalPaneKind } from "@/terminal"
import type { FirstPartyEntries } from "./registries"
import { settingsPage } from "./view/settings-page"

export const firstParty: FirstPartyEntries = {
  pages: [settingsPage, projectPage, addProjectPage],
  paneKinds: [sessionPaneKind, draftSessionPaneKind, filePaneKind, terminalPaneKind],
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
