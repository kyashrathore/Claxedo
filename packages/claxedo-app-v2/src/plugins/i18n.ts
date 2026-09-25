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
  "plugins.warning": "A plugin runs inside Claxedo with your access. It can see everything you see and act as you on your server. It can't reach the internet.",
  "plugins.unapproved": "Waiting for your approval",
  "plugins.accessChanged": "Asks for different access. Turn it on to review the change.",
  "plugins.codeChanged": "Code changed since you approved, {{time}}",
  "plugins.details": "Details",
  "plugins.viewCode": "View code",
  "plugins.manifest.id": "ID",
  "plugins.manifest.version": "Version",
  "plugins.manifest.folder": "Folder",
  "plugins.manifest.routes": "Server routes",
  "plugins.manifest.operations": "Operations",
  "plugins.manifest.requires": "Requires",
  "plugins.manifest.build": "Build",
  "plugins.manifest.builtAt": "Last built",
  "plugins.manifest.none": "None",
  "plugins.approval.new": "Turn on {{name}}?",
  "plugins.approval.access": "{{name}} asks for different access",
  "plugins.approval.code": "{{name}} has new code",
  "plugins.approval.accept": "Turn on",
  "plugins.approval.added": "Now asks for",
  "plugins.approval.removed": "No longer asks for",
  "plugins.approval.route": "Route {{value}}",
  "plugins.approval.operation": "Operation {{value}}",
  "plugins.approval.requires": "Needs {{value}}",
  "plugins.approval.stale": "{{name}} changed again while you were reading. Review the new version.",
  "plugins.source.title": "{{name}}: code",
  "plugins.source.files": "Files",
  "plugins.source.loading": "Loading",
  "plugins.source.failed": "The code could not be read: {{reason}}",
  "plugins.source.truncated": "Only the first {{count}} files are listed.",
  "plugins.source.pick": "Pick a file to read it.",
  "plugins.source.empty": "This folder has no files to show.",
  "plugins.failure": "{{reason}}",
  "plugins.lastFailure": "The newest build failed, so the previous one keeps running: {{reason}}",
  "plugins.remove": "Remove",
  "plugins.remove.title": "Remove {{name}}?",
  "plugins.remove.description": "The plugin is unregistered from this machine. Its folder is kept.",
  "plugins.remove.failed": "Removing {{name}} failed: {{reason}}",
  "plugins.cancel": "Cancel",
  "plugins.confirm": "Confirm",
  "plugins.close": "Close",
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
