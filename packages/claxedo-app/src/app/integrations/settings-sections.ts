import { createContributionRegistry, type ContributionGateContext, type SettingsContribution, type SettingsSection } from "./registry"

/**
 * Settings sections a feature contributes to the Settings dialog.
 *
 * Its own registry instance rather than the content-surface one: that module
 * statically imports the session surface, and the Settings dialog is a lazy
 * chunk that must not pull the shell's eager graph in behind it. The registry
 * mechanism — gating, upsert, the revision that makes a late registration
 * visible to a renderer that already read the list — is the same one.
 */
const registry = createContributionRegistry()

export function registerSettingsSection(section: SettingsContribution) {
  registry.addSettings(section)
}

export function settingsSections(section: SettingsSection, context: ContributionGateContext = {}) {
  return registry.visibleSettings(context).filter((entry) => entry.section === section)
}
