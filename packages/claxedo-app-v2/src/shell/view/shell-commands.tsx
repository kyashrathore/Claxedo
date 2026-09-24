import type { JSX } from "solid-js"
import { useI18n, useTranslator } from "@/i18n"
import { dictionary } from "../i18n"
import { useShellLayout } from "../layout"
import { useCommands } from "../palette/commands"
import type { CommandOption } from "../palette/registrations"
import { useShellRegistries } from "../registries"
import { useShellRoute } from "../router"
import { draftPath, fillPattern, homePath, settingsPath } from "../routes"
import { useActivePlacement } from "../active-placement"
import { NEW_SESSION_COMMAND } from "./scope-buttons"
import { useThemeCommands } from "./theme-commands"

export function ShellCommands(): JSX.Element {
  const t = useTranslator(dictionary)
  const i18n = useI18n()
  const commands = useCommands()
  const layout = useShellLayout()
  const routing = useShellRoute()
  const registries = useShellRegistries()
  const active = useActivePlacement()
  const newSession = () => {
    const placement = active()
    if (placement) routing.navigate(draftPath(placement))
  }

  const layoutCommands = (): CommandOption[] => [
    { id: NEW_SESSION_COMMAND, title: t("shell.command.newSession"), category: t("shell.category.session"), keybind: "mod+shift+s", onSelect: newSession },
    { id: "shell.sidebar.toggle", title: t("shell.command.sidebarToggle"), category: t("shell.category.view"), keybind: "mod+b", onSelect: () => layout.send({ type: "toggleSidebar" }) },
    { id: "shell.panel.toggle", title: t("shell.command.panelToggle"), category: t("shell.category.view"), keybind: "mod+shift+b", onSelect: () => layout.send({ type: "togglePanel" }) },
    { id: "shell.home", title: t("shell.command.home"), category: t("shell.category.view"), onSelect: () => routing.navigate(homePath) },
    { id: "shell.settings.open", title: t("shell.command.settings"), category: t("shell.category.settings"), keybind: "mod+,", onSelect: () => routing.navigate(settingsPath()) },
  ]

  const themeCommands = useThemeCommands()

  const languageCommands = (): CommandOption[] =>
    i18n.locales.map((entry) => ({
      id: `shell.language.${entry.code}`,
      title: t("shell.command.setLanguage", { language: entry.label }),
      category: t("shell.command.language"),
      onSelect: () => i18n.setLocale(entry.code),
    }))

  const pageCommands = (): CommandOption[] =>
    registries.pages.list().map((page) => ({
      id: `shell.page.${page.id}`,
      title: page.title(),
      category: t("shell.category.view"),
      onSelect: () => routing.navigate(fillPattern(page.path)),
    }))

  commands.register("shell", () => [...layoutCommands(), ...themeCommands(), ...languageCommands(), ...pageCommands()])
  return null
}
