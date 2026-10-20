import { unreachable } from "@/lib/machine"
import type { MarketplaceKey } from "../i18n"
import type { AppPluginActions } from "./actions"
import type { AppPluginEntry, AppPluginMainAction } from "./model"

export const MAIN_ACTION_LABEL: Readonly<Record<AppPluginMainAction, MarketplaceKey>> = {
  install: "marketplace.app.action.install",
  turnOn: "marketplace.app.action.turnOn",
  turnOff: "marketplace.app.action.turnOff",
  turnOnForOrganization: "marketplace.app.action.turnOnForOrganization",
}

export function runMainAction(actions: AppPluginActions, action: AppPluginMainAction, entry: AppPluginEntry): Promise<void> {
  switch (action) {
    case "install":
      return actions.install(entry)
    case "turnOn":
      return actions.turnOn(entry)
    case "turnOff":
      return actions.turnOff(entry)
    case "turnOnForOrganization":
      return actions.setActiveForOrganization(entry, true)
    default:
      return unreachable(action)
  }
}
