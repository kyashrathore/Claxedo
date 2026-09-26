import { useTranslator, type DomainTranslate } from "@/i18n"
import { showToast, useTheme, type ColorScheme } from "@/ui"
import { shellDictionary, type ShellKey } from "../i18n"
import type { CommandOption } from "../palette/registrations"

const COLOR_SCHEMES: readonly ColorScheme[] = ["system", "light", "dark"]

function nextOf<T>(items: readonly T[], current: T): T | undefined {
  if (items.length === 0) return undefined
  const index = items.indexOf(current)
  return items[index === -1 ? 0 : (index + 1) % items.length]
}

type Theme = ReturnType<typeof useTheme>
type Translate = DomainTranslate<ShellKey>

function previewed(theme: Theme, preview: () => void) {
  return {
    onSelect: () => theme.commitPreview(),
    onHighlight: () => {
      preview()
      return () => theme.cancelPreview()
    },
  }
}

function schemeLabel(t: Translate, scheme: ColorScheme): string {
  return t(`shell.scheme.${scheme}`)
}

function useCycles(theme: Theme, t: Translate) {
  return {
    theme: () => {
      const next = nextOf(theme.ids(), theme.themeId())
      if (!next) return
      theme.setTheme(next)
      showToast({ title: t("shell.toast.theme"), description: theme.name(next) })
    },
    scheme: () => {
      const next = nextOf(COLOR_SCHEMES, theme.colorScheme())
      if (!next) return
      theme.setColorScheme(next)
      showToast({ title: t("shell.toast.colorScheme"), description: schemeLabel(t, next) })
    },
  }
}

export function useThemeCommands(): () => CommandOption[] {
  const t = useTranslator(shellDictionary)
  const theme = useTheme()
  const cycles = useCycles(theme, t)
  const category = () => t("shell.category.theme")
  return () => [
    { id: "theme.cycle", title: t("shell.command.themeCycle"), category: category(), onSelect: cycles.theme },
    ...theme.ids().map((id) => ({
      id: `theme.set.${id}`,
      title: t("shell.command.theme", { name: theme.name(id) }),
      category: category(),
      ...previewed(theme, () => theme.previewTheme(id)),
    })),
    { id: "theme.scheme.cycle", title: t("shell.command.schemeCycle"), category: category(), onSelect: cycles.scheme },
    ...COLOR_SCHEMES.map((scheme) => ({
      id: `theme.scheme.${scheme}`,
      title: t("shell.command.scheme", { scheme: schemeLabel(t, scheme) }),
      category: category(),
      ...previewed(theme, () => theme.previewColorScheme(scheme)),
    })),
  ]
}
