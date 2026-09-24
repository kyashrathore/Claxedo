import { sessionPaneKind } from "./placeholders/session-pane"
import type { FirstPartyEntries } from "./registries"
import type { AnyPaneKind } from "./types"
import { settingsPage } from "./view/settings-page"

export const firstParty: FirstPartyEntries = {
  pages: [settingsPage],
  paneKinds: [sessionPaneKind as AnyPaneKind],
  panelTabs: [],
  settingsSections: [],
  sidebarItems: [],
  overlays: [],
  commands: [],
  mentions: [],
  themes: [],
  iconSkins: [],
  routes: [],
}
