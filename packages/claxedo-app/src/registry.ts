import { accessDictionary } from "@/access"
import { accountsDictionary, modelsSettingsSection, sandboxSettingsSection, teamSettingsSection } from "@/accounts"
import { composerDictionary } from "@/composer"
import { authRoutes } from "@/auth"
import { errorDictionary, type Translations } from "@/i18n"
import { notificationsDictionary } from "@/notifications"
import { onboardingRoute } from "@/onboarding"
import { panelDictionary } from "@/panel"
import { pluginsSettingsSection } from "@/plugins"
import { projectsDictionary, projectsSettingsSection } from "@/projects"
import { marketplacePage, railDictionary, tasksPage } from "@/rail"
import { reviewDictionary } from "@/review"
import { settingsDictionary, settingsSections } from "@/settings"
import { presetsSettingsSection } from "@/tasks"
import { draftSessionPaneKind, sessionDetailsPanelView, sessionPaneKind, sessionScreenDictionary, subagentPanelView } from "@/session"
import { transcriptDictionary } from "@/transcript"
import { usageDictionary } from "@/usage"
import { terminalCreatorPaneKind, terminalPaneKind } from "@/terminal"
import { pageTabPaneKind, paneKindEntry, settingsPage, shellDictionary, type FirstPartyEntries } from "@/shell"
import { workbenchDictionary } from "@/workbench"

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
  settingsSections: [...settingsSections, modelsSettingsSection, teamSettingsSection, sandboxSettingsSection, projectsSettingsSection, pluginsSettingsSection, presetsSettingsSection],
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
  composerDictionary,
  sessionScreenDictionary,
  panelDictionary,
  workbenchDictionary,
  accessDictionary,
]
