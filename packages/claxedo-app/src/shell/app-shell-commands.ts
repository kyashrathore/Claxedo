import { createMemo, type Accessor } from "solid-js"
import { showToast } from "@opencode-ai/ui/toast"
import { useTheme, type ColorScheme } from "@opencode-ai/ui/theme"
import { useCommand } from "@claxedo/context/command"
import { createProcessPaneToggleCommand } from "../claxedo-ui/claxedo-layout-commands"
import type { ClaxedoStateApi } from "../claxedo-ui/state"
import { capture as phCapture } from "../analytics/posthog"

export function useClaxedoAppShellCommands(input: {
  state: ClaxedoStateApi
  activeWorkspaceId: Accessor<string | undefined>
}) {
  const command = useCommand()
  const theme = useTheme()
  const availableThemeEntries = createMemo(() => theme.ids().map((id) => [id, theme.themes()[id]?.name ?? id] as const))
  const colorSchemeOrder: ColorScheme[] = ["system", "light", "dark"]
  const colorSchemeLabel = (scheme: ColorScheme) => {
    if (scheme === "system") return "System"
    if (scheme === "light") return "Light"
    return "Dark"
  }
  const cycleTheme = (direction = 1) => {
    const ids = availableThemeEntries().map(([id]) => id)
    if (ids.length === 0) return
    const currentIndex = ids.indexOf(theme.themeId())
    const nextThemeId = ids[currentIndex === -1 ? 0 : (currentIndex + direction + ids.length) % ids.length]
    theme.setTheme(nextThemeId)
    showToast({
      title: "Theme",
      description: theme.name(nextThemeId),
    })
  }
  const cycleColorScheme = (direction = 1) => {
    const currentIndex = colorSchemeOrder.indexOf(theme.colorScheme())
    const next = colorSchemeOrder[currentIndex === -1 ? 0 : (currentIndex + direction + colorSchemeOrder.length) % colorSchemeOrder.length]
    theme.setColorScheme(next)
    showToast({
      title: "Color scheme",
      description: colorSchemeLabel(next),
    })
  }

  command.register("claxedo-layout", () => [
    createProcessPaneToggleCommand(() => {
      phCapture("process_pane_toggled")
      input.state.workspacePanel.toggle("processes", {
        workspaceDir: input.activeWorkspaceId(),
        navigator: "processes",
      })
    }),
    {
      id: "theme.cycle",
      title: "Cycle theme",
      category: "Theme",
      onSelect: () => cycleTheme(1),
    },
    ...availableThemeEntries().map(([id, name]) => ({
      id: `theme.set.${id}`,
      title: `Set theme: ${name}`,
      category: "Theme",
      onSelect: () => theme.commitPreview(),
      onHighlight: () => {
        theme.previewTheme(id)
        return () => theme.cancelPreview()
      },
    })),
    {
      id: "theme.scheme.cycle",
      title: "Cycle color scheme",
      category: "Theme",
      keybind: "mod+shift+s",
      onSelect: () => cycleColorScheme(1),
    },
    ...colorSchemeOrder.map((scheme) => ({
      id: `theme.scheme.${scheme}`,
      title: `Set color scheme: ${colorSchemeLabel(scheme)}`,
      category: "Theme",
      onSelect: () => theme.commitPreview(),
      onHighlight: () => {
        theme.previewColorScheme(scheme)
        return () => theme.cancelPreview()
      },
    })),
  ])
}
