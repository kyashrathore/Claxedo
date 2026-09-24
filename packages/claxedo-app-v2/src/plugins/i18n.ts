import { useTranslator, type DomainTranslate, type Translations } from "@/i18n"

const en = {
  "plugins.settings.title": "Plugins",
  "plugins.settings.description": "Plugins add pages, panes, commands and themes. Switching one off removes everything it added.",
  "plugins.settings.empty": "No plugins yet.",
  "plugins.origin.bundled": "Built in",
  "plugins.origin.live": "From this machine",
  "plugins.state.off": "Off",
  "plugins.state.loading": "Starting",
  "plugins.state.on": "On",
  "plugins.state.swapping": "Updating",
  "plugins.state.failed": "Failed",
  "plugins.switch": "{{name}} on",
  "plugins.missing": "Needs {{capabilities}} on the connected server",
  "plugins.unconfirmed": "Waiting for your confirmation",
  "plugins.failure": "{{reason}}",
  "plugins.lastFailure": "The newest build failed, so the previous one keeps running: {{reason}}",
  "plugins.remove": "Remove",
  "plugins.remove.title": "Remove {{name}}?",
  "plugins.remove.description": "The plugin is unregistered from this machine. Its folder is kept.",
  "plugins.remove.failed": "Removing {{name}} failed: {{reason}}",
  "plugins.cancel": "Cancel",
  "plugins.confirm": "Confirm",
  "plugins.close": "Close",
  "plugins.add.title": "Turn on {{name}}?",
  "plugins.add.desktop": "{{name}} was added on this machine. It runs with the app's full access on this device, so turn it on only if you trust its code.",
  "plugins.add.web": "{{name}} was added on this machine. In the browser it runs in a sandboxed frame.",
  "plugins.add.accept": "Turn on",
  "plugins.safeMode": "Safe mode: every plugin from this machine is off.",
  "plugins.safeMode.leave": "Leave safe mode",
  "plugins.boundary.failed": "{{name}} failed",
  "plugins.boundary.retry": "Try again",
  "plugins.off": "{{name}} is off. Turn it on in Settings, Plugins.",
  "plugins.list.failed": "The plugins on this machine could not be read: {{reason}}",
}

export type PluginsKey = keyof typeof en

export const dictionary = { en } satisfies Translations<PluginsKey>

export type PluginsText = DomainTranslate<PluginsKey>

export function usePluginsText(): PluginsText {
  return useTranslator(dictionary)
}
