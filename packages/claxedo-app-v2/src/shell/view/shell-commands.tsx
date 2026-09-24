import type { JSX } from "solid-js"
import { useI18n, useTranslator } from "@/i18n"
import { useTheme, type ColorScheme } from "@opencode-ai/ui/theme"
import { dictionary } from "../i18n"
import { useShellLayout } from "../layout"
import { useCommands } from "../palette/commands"
import type { CommandOption } from "../palette/registrations"
import { useShellRegistries } from "../registries"
import { useShellRoute } from "../router"
import { draftPath, fillPattern, homePath, settingsPath } from "../routes"
import { useActivePlacement } from "../active-placement"
import { NEW_SESSION_COMMAND } from "./scope-buttons"

const colorSchemes: readonly ColorScheme[] = ["system", "light", "dark"]

export function ShellCommands(): JSX.Element {
  const t = useTranslator(dictionary)
  const i18n = useI18n()
  const commands = useCommands()
  const layout = useShellLayout()
  const routing = useShellRoute()
  const registries = useShellRegistries()
  const theme = useTheme()
  const active = useActivePlacement()
  const newSession = () => {
    const placement = active()
    if (placement) routing.navigate(draftPath(placement))
  }

  const schemeLabel = (scheme: ColorScheme) => t(`shell.scheme.${scheme}`)
  const cycleScheme = () => {
    const index = colorSchemes.indexOf(theme.colorScheme())
    theme.setColorScheme(colorSchemes[(index + 1) % colorSchemes.length])
  }

  const layoutCommands = (): CommandOption[] => [
    { id: NEW_SESSION_COMMAND, title: t("shell.command.newSession"), category: t("shell.category.session"), keybind: "mod+shift+s", onSelect: newSession },
    { id: "shell.sidebar.toggle", title: t("shell.command.sidebarToggle"), category: t("shell.category.view"), keybind: "mod+b", onSelect: () => layout.send({ type: "toggleSidebar" }) },
    { id: "shell.panel.toggle", title: t("shell.command.panelToggle"), category: t("shell.category.view"), keybind: "mod+shift+b", onSelect: () => layout.send({ type: "togglePanel" }) },
    { id: "shell.home", title: t("shell.command.home"), category: t("shell.category.view"), onSelect: () => routing.navigate(homePath) },
    { id: "shell.settings.open", title: t("shell.command.settings"), category: t("shell.category.settings"), keybind: "mod+,", onSelect: () => routing.navigate(settingsPath()) },
  ]

  const themeCommands = (): CommandOption[] => [
    { id: "shell.scheme.cycle", title: t("shell.command.schemeCycle"), category: t("shell.category.theme"), onSelect: cycleScheme },
    ...colorSchemes.map((scheme) => ({
      id: `shell.scheme.${scheme}`,
      title: t("shell.command.scheme", { scheme: schemeLabel(scheme) }),
      category: t("shell.category.theme"),
      onSelect: () => theme.setColorScheme(scheme),
    })),
    ...theme.ids().map((id) => ({
      id: `shell.theme.${id}`,
      title: t("shell.command.theme", { name: theme.name(id) }),
      category: t("shell.category.theme"),
      onSelect: () => theme.setTheme(id),
    })),
  ]

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
