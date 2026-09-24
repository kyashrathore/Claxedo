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

function useLayoutCommands(): () => CommandOption[] {
  const t = useTranslator(dictionary)
  const layout = useShellLayout()
  const routing = useShellRoute()
  const active = useActivePlacement()
  const newSession = () => {
    const placement = active()
    if (placement) routing.navigate(draftPath(placement))
  }
  return () => [
    { id: NEW_SESSION_COMMAND, title: t("shell.command.newSession"), category: t("shell.category.session"), keybind: "mod+shift+s", onSelect: newSession },
    { id: "shell.sidebar.toggle", title: t("shell.command.sidebarToggle"), category: t("shell.category.view"), keybind: "mod+b", onSelect: () => layout.send({ type: "toggleSidebar" }) },
    { id: "shell.panel.toggle", title: t("shell.command.panelToggle"), category: t("shell.category.view"), keybind: "mod+shift+b", onSelect: () => layout.send({ type: "togglePanel" }) },
    { id: "shell.home", title: t("shell.command.home"), category: t("shell.category.view"), onSelect: () => routing.navigate(homePath) },
    { id: "shell.settings.open", title: t("shell.command.settings"), category: t("shell.category.settings"), keybind: "mod+,", onSelect: () => routing.navigate(settingsPath()) },
  ]
}

function useLanguageCommands(): () => CommandOption[] {
  const t = useTranslator(dictionary)
  const i18n = useI18n()
  return () =>
    i18n.locales.map((entry) => ({
      id: `shell.language.${entry.code}`,
      title: t("shell.command.setLanguage", { language: entry.label }),
      category: t("shell.command.language"),
      onSelect: () => i18n.setLocale(entry.code),
    }))
}

function usePageCommands(): () => CommandOption[] {
  const t = useTranslator(dictionary)
  const routing = useShellRoute()
  const registries = useShellRegistries()
  return () =>
    registries.pages.list().map((page) => ({
      id: `shell.page.${page.id}`,
      title: page.title(),
      category: t("shell.category.view"),
      onSelect: () => routing.navigate(fillPattern(page.path)),
    }))
}

export function ShellCommands(): JSX.Element {
  const commands = useCommands()
  const groups = [useLayoutCommands(), useThemeCommands(), useLanguageCommands(), usePageCommands()]
  commands.register("shell", () => groups.flatMap((group) => group()))
  return null
}
