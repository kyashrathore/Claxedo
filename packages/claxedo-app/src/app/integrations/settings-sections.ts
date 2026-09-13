import { createContributionRegistry, type ContributionGateContext, type SettingsContribution } from "./registry"

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

/**
 * Every contributed section this context may see, in registration order.
 *
 * Which group each one joins is the dialog's own layout question, so the answer
 * carries `section` rather than being filtered here: the dialog lists all three
 * groups and mounts the content for every one of them.
 */
export function settingsSections(context: ContributionGateContext) {
  return registry.visibleSettings(context)
}
