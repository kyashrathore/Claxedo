import { useTranslator, type DomainTranslate, type Translations } from "@/i18n"

const en = {
  "plugins.settings.title": "App plugins",
  "plugins.settings.description": "App plugins add pages, panes, commands and themes to this app. Agent plugins, which add skills and tools to agents, live in the Marketplace. Switching an app plugin off removes everything it added.",
  "plugins.settings.empty": "No app plugins yet.",
  "plugins.origin.bundled": "Built in",
  "plugins.origin.live": "From this machine",
  "plugins.state.off": "Off",
  "plugins.state.loading": "Starting",
  "plugins.state.on": "On",
  "plugins.state.swapping": "Updating",
  "plugins.state.failed": "Failed",
  "plugins.switch": "{{name}} on",
  "plugins.missing": "Needs {{capabilities}} on the connected server",
  "plugins.warning.desktop": "App plugins run inside this app, unsandboxed, with its full access on this computer. An app plugin sees what you see, acts as you on your server, and can open links in your browser that carry your data out. Turn on only app plugins you trust.",
  "plugins.warning.web": "App plugins run sandboxed in frames. An app plugin sees only what this app passes it and reaches only the server routes and operations its manifest names, as you, and nothing else on the network. Turn on only app plugins you trust.",
  "plugins.unapproved": "Waiting for your approval",
  "plugins.accessChanged": "Asks for different access. Turn it on to review the change.",
  "plugins.codeChanged": "Code changed since you approved, {{time}}",
  "plugins.details": "Details",
  "plugins.manifest.name": "Name",
  "plugins.manifest.id": "ID",
  "plugins.manifest.version": "Version",
  "plugins.manifest.folder": "Folder",
  "plugins.manifest.routes": "Server routes",
  "plugins.manifest.operations": "Operations",
  "plugins.manifest.requires": "Requires",
  "plugins.manifest.build": "Build",
  "plugins.manifest.builtAt": "Last built",
  "plugins.manifest.none": "None",
  "plugins.manifest.copyFolder": "Copy folder path",
  "plugins.manifest.copyFailed": "The folder path could not be copied: {{reason}}",
  "plugins.approval.new": "Turn on the app plugin {{name}}?",
  "plugins.approval.access": "The app plugin {{name}} asks for different access",
  "plugins.approval.code": "The app plugin {{name}} has new code",
  "plugins.approval.accept": "Turn on",
  "plugins.approval.added": "Now asks for",
  "plugins.approval.removed": "No longer asks for",
  "plugins.approval.route": "Route {{value}}",
  "plugins.approval.operation": "Operation {{value}}",
  "plugins.approval.requires": "Needs {{value}}",
  "plugins.approval.stale": "{{name}} changed again while you were reading. Review the new version.",
  "plugins.failure": "{{reason}}",
  "plugins.lastFailure": "The newest build failed, so the previous one keeps running: {{reason}}",
  "plugins.remove": "Remove",
  "plugins.remove.title": "Remove {{name}}?",
  "plugins.remove.description": "The app plugin is unregistered from this machine. Its folder is kept.",
  "plugins.remove.failed": "Removing the app plugin {{name}} failed: {{reason}}",
  "plugins.cancel": "Cancel",
  "plugins.confirm": "Confirm",
  "plugins.safeMode": "Safe mode: every app plugin from this machine is off.",
  "plugins.safeMode.leave": "Leave safe mode",
  "plugins.boundary.failed": "The app plugin {{name}} failed",
  "plugins.boundary.retry": "Try again",
  "plugins.off": "The app plugin {{name}} is off. Turn it on in Settings, App plugins.",
  "plugins.list.notOwner": "App plugins on this machine belong to its owner, so none run for you here.",
  "plugins.list.failed": "The app plugins on this machine could not be read: {{reason}}",
}

export type PluginsKey = keyof typeof en

export const dictionary = { en } satisfies Translations<PluginsKey>

export type PluginsText = DomainTranslate<PluginsKey>

export function usePluginsText(): PluginsText {
  return useTranslator(dictionary)
}
