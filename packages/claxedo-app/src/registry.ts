import { accountsDictionary, modelsSettingsSection, sandboxSettingsSection } from "@/accounts"
import { authRoutes } from "@/auth"
import { errorDictionary, type Translations } from "@/i18n"
import { notificationsDictionary } from "@/notifications"
import { onboardingRoute } from "@/onboarding"
import { pluginsSettingsSection } from "@/plugins"
import { projectsDictionary, projectsSettingsSection } from "@/projects"
import { marketplacePage, railDictionary, tasksPage } from "@/rail"
import { reviewDictionary } from "@/review"
import { settingsDictionary, settingsSections } from "@/settings"
import { presetsSettingsSection } from "@/tasks"
import { draftSessionPaneKind, sessionDetailsPanelView, sessionPaneKind, subagentPanelView } from "@/session"
import { transcriptDictionary } from "@/transcript"
import { usageDictionary } from "@/usage"
import { terminalCreatorPaneKind, terminalPaneKind } from "@/terminal"
import { pageTabPaneKind, paneKindEntry, settingsPage, shellDictionary, type FirstPartyEntries } from "@/shell"

export const firstParty: FirstPartyEntries = {
  pages: [settingsPage, tasksPage, marketplacePage],
  paneKinds: [
    paneKindEntry(sessionPaneKind),
    paneKindEntry(draftSessionPaneKind),
    paneKindEntry(terminalPaneKind),
    paneKindEntry(terminalCreatorPaneKind),
    paneKindEntry(pageTabPaneKind),
  ],
  panelViews: [subagentPanelView, sessionDetailsPanelView],
  settingsSections: [...settingsSections, modelsSettingsSection, sandboxSettingsSection, projectsSettingsSection, pluginsSettingsSection, presetsSettingsSection],
  sidebarItems: [],
  overlays: [],
  commands: [],
  mentions: [],
  themes: [],
  iconSkins: [],
  routes: [onboardingRoute, ...authRoutes],
}

export const firstPartyDictionaries: readonly Translations[] = [
  errorDictionary,
  shellDictionary,
  railDictionary,
  projectsDictionary,
  transcriptDictionary,
  notificationsDictionary,
  settingsDictionary,
  usageDictionary,
  accountsDictionary,
  reviewDictionary,
]
