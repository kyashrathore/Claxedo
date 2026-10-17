import type { Translations } from "@/i18n"
import type { ConsentKey } from "./consent"

type McpAppsKey =
  | ConsentKey
  | "mcpApps.frame.title"
  | "mcpApps.loading"
  | "mcpApps.loadingSlow"
  | "mcpApps.stopped"
  | "mcpApps.unavailable"
  | "mcpApps.fullscreen.enter"
  | "mcpApps.fullscreen.exit"

export const mcpAppsDictionary = {
  en: {
    "mcpApps.frame.title": "{{server}} app",
    "mcpApps.loading": "Loading the app…",
    "mcpApps.loadingSlow": "Waiting for the app's page…",
    "mcpApps.stopped": "The app tried to leave its page, so it was stopped.",
    "mcpApps.unavailable": "The app's server is not reachable. Send a message in this session, then try again.",
    "mcpApps.fullscreen.enter": "Full screen",
    "mcpApps.fullscreen.exit": "Exit full screen",
    "mcpApps.consent.cancel": "Cancel",
    "mcpApps.consent.toolCall.title": "Let the app run a tool?",
    "mcpApps.consent.toolCall.body": "{{server}} · {{tool}}\n{{arguments}}",
    "mcpApps.consent.toolCall.confirm": "Run tool",
    "mcpApps.consent.message.title": "Let the app send a message?",
    "mcpApps.consent.message.body": "{{message}}",
    "mcpApps.consent.message.confirm": "Send",
  },
} satisfies Translations<McpAppsKey>
