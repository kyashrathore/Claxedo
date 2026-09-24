import { useTranslator } from "@/i18n"
import { showToast } from "@/ui"
import { useTheme, type ColorScheme } from "@opencode-ai/ui/theme"
import { dictionary } from "../i18n"
import type { CommandOption } from "../palette/registrations"

const COLOR_SCHEMES: readonly ColorScheme[] = ["system", "light", "dark"]

function nextOf<T>(items: readonly T[], current: T): T | undefined {
  if (items.length === 0) return undefined
  const index = items.indexOf(current)
  return items[index === -1 ? 0 : (index + 1) % items.length]
}

export function useThemeCommands(): () => CommandOption[] {
  const t = useTranslator(dictionary)
  const theme = useTheme()
  const category = () => t("shell.category.theme")
  const schemeLabel = (scheme: ColorScheme) => t(`shell.scheme.${scheme}`)
  const cycleTheme = () => {
    const next = nextOf(theme.ids(), theme.themeId())
    if (!next) return
    theme.setTheme(next)
    showToast({ title: t("shell.toast.theme"), description: theme.name(next) })
  }
  const cycleScheme = () => {
    const next = nextOf(COLOR_SCHEMES, theme.colorScheme())
    if (!next) return
    theme.setColorScheme(next)
    showToast({ title: t("shell.toast.colorScheme"), description: schemeLabel(next) })
  }
  return () => [
    { id: "theme.cycle", title: t("shell.command.themeCycle"), category: category(), onSelect: cycleTheme },
    ...theme.ids().map((id) => ({
      id: `theme.set.${id}`,
      title: t("shell.command.theme", { name: theme.name(id) }),
      category: category(),
      onSelect: () => theme.commitPreview(),
      onHighlight: () => {
        theme.previewTheme(id)
        return () => theme.cancelPreview()
      },
    })),
    { id: "theme.scheme.cycle", title: t("shell.command.schemeCycle"), category: category(), onSelect: cycleScheme },
    ...COLOR_SCHEMES.map((scheme) => ({
      id: `theme.scheme.${scheme}`,
      title: t("shell.command.scheme", { scheme: schemeLabel(scheme) }),
      category: category(),
      onSelect: () => theme.commitPreview(),
      onHighlight: () => {
        theme.previewColorScheme(scheme)
        return () => theme.cancelPreview()
      },
    })),
  ]
}
