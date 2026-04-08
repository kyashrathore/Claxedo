import { Component, createEffect, createMemo, createSignal, onCleanup, onMount, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Select } from "@opencode-ai/ui/select"
import { Switch } from "@opencode-ai/ui/switch"
import { showToast } from "@opencode-ai/ui/toast"
import {
  loadThemeFromUrl,
  resolveThemeVariant,
  useTheme,
  type ColorScheme,
  type DesktopTheme,
  type HexColor,
  type ResolvedTheme,
  type ThemeVariant,
} from "@opencode-ai/ui/theme"
import { saveStoredTheme } from "@opencode-ai/ui/theme/storage"
import { useLanguage } from "@/context/language"
import { useSettings, monoFontFamily } from "@/context/settings"
import { Link } from "@/components/link"
import { capture as phCapture } from "../analytics/posthog"

const STORAGE_KEY = "claxedo.appearance.v1"
const STORAGE_EVENT = "claxedo:appearance"

const fontOptions = [
  { value: "ibm-plex-mono", label: "font.option.ibmPlexMono" },
  { value: "cascadia-code", label: "font.option.cascadiaCode" },
  { value: "fira-code", label: "font.option.firaCode" },
  { value: "hack", label: "font.option.hack" },
  { value: "inconsolata", label: "font.option.inconsolata" },
  { value: "intel-one-mono", label: "font.option.intelOneMono" },
  { value: "iosevka", label: "font.option.iosevka" },
  { value: "jetbrains-mono", label: "font.option.jetbrainsMono" },
  { value: "meslo-lgs", label: "font.option.mesloLgs" },
  { value: "roboto-mono", label: "font.option.robotoMono" },
  { value: "source-code-pro", label: "font.option.sourceCodePro" },
  { value: "ubuntu-mono", label: "font.option.ubuntuMono" },
] as const

const FONT_SIZE_OPTIONS = [
  { value: 11, label: "11 px" },
  { value: 12, label: "12 px" },
  { value: 13, label: "13 px" },
  { value: 14, label: "14 px" },
  { value: 15, label: "15 px" },
  { value: 16, label: "16 px" },
]

interface AppearanceOverrides {
  accentColor: string
  backgroundColor: string
  foregroundColor: string
  diffAddColor: string
  diffDeleteColor: string
  diffModifiedColor: string
  diffAddText: string
  diffDeleteText: string
  diffAddStrong: string
  diffDeleteStrong: string
  diffTint: number
  contrast: number
  uiFontSize: number
  translucentSidebar: boolean
  pointerCursors: boolean
}

const DEFAULTS: AppearanceOverrides = {
  accentColor: "",
  backgroundColor: "",
  foregroundColor: "",
  diffAddColor: "",
  diffDeleteColor: "",
  diffModifiedColor: "",
  diffAddText: "",
  diffDeleteText: "",
  diffAddStrong: "",
  diffDeleteStrong: "",
  diffTint: 50,
  contrast: 50,
  uiFontSize: 13,
  translucentSidebar: false,
  pointerCursors: false,
}

function loadOverrides(): AppearanceOverrides {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULTS }
  }
}

export function applyAppearanceOverrides() {
  const input = loadOverrides()
  if (input.uiFontSize !== DEFAULTS.uiFontSize) {
    document.documentElement.style.setProperty("--font-size-base", `${input.uiFontSize}px`)
  }
  document.documentElement.classList.toggle("use-pointer-cursors", input.pointerCursors)
  document.documentElement.classList.toggle("translucent-sidebar", input.translucentSidebar)
}

function saveOverrides(input: AppearanceOverrides) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(input))
    window.dispatchEvent(new CustomEvent(STORAGE_EVENT))
  } catch {}
}

function clone(theme: DesktopTheme) {
  return JSON.parse(JSON.stringify(theme)) as DesktopTheme
}

function hex(input: string | undefined) {
  return input?.startsWith("#") ? (input as HexColor) : undefined
}

function read(input: ResolvedTheme | null, key: string) {
  return hex(input?.[key])
}

function neutral(input: ThemeVariant) {
  return "palette" in input && input.palette ? input.palette.neutral : input.seeds.neutral
}

function primary(input: ThemeVariant) {
  return "palette" in input && input.palette ? input.palette.primary : input.seeds.primary
}

function ink(input: ThemeVariant) {
  return "palette" in input && input.palette ? input.palette.ink : undefined
}

function diffAdd(input: ThemeVariant) {
  return "palette" in input && input.palette ? input.palette.diffAdd : input.seeds.diffAdd
}

function diffDelete(input: ThemeVariant) {
  return "palette" in input && input.palette ? input.palette.diffDelete : input.seeds.diffDelete
}

function setNeutral(input: ThemeVariant, value: HexColor) {
  if ("palette" in input && input.palette) {
    input.palette.neutral = value
    return
  }
  input.seeds.neutral = value
}

function setPrimary(input: ThemeVariant, value: HexColor) {
  if ("palette" in input && input.palette) {
    input.palette.primary = value
    return
  }
  input.seeds.primary = value
}

function setInk(input: ThemeVariant, value: HexColor) {
  if ("palette" in input && input.palette) {
    input.palette.ink = value
  }
}

function setDiffAdd(input: ThemeVariant, value: HexColor) {
  if ("palette" in input && input.palette) {
    input.palette.diffAdd = value
    return
  }
  input.seeds.diffAdd = value
}

function setDiffDelete(input: ThemeVariant, value: HexColor) {
  if ("palette" in input && input.palette) {
    input.palette.diffDelete = value
    return
  }
  input.seeds.diffDelete = value
}

function shiftLightness(input: HexColor, delta: number) {
  const parts = [1, 3, 5].map((start) => parseInt(input.slice(start, start + 2), 16) / 255)
  const next = parts.map((item) => Math.max(0, Math.min(1, item + delta)))
  return (`#${next
    .map((item) =>
      Math.round(item * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`) as HexColor
}

function withOverrides(theme: DesktopTheme, input: AppearanceOverrides) {
  const next = clone(theme)
  const delta = (input.contrast - 50) / 250

  for (const variant of [next.light, next.dark]) {
    if (input.accentColor) setPrimary(variant, input.accentColor as HexColor)
    if (input.backgroundColor) setNeutral(variant, input.backgroundColor as HexColor)
    if (input.foregroundColor) {
      setInk(variant, input.foregroundColor as HexColor)
    }
    if (input.diffAddColor) setDiffAdd(variant, input.diffAddColor as HexColor)
    if (input.diffDeleteColor) setDiffDelete(variant, input.diffDeleteColor as HexColor)
    if (input.contrast !== 50) {
      const base = neutral(variant)
      const sign = parseInt(base.slice(1, 3), 16) < 128 ? -1 : 1
      setNeutral(variant, shiftLightness(base, delta * sign))
    }
    const overrides = { ...(variant.overrides ?? {}) }
    if (input.foregroundColor) {
      overrides["text-base"] = input.foregroundColor as HexColor
      overrides["markdown-text"] = input.foregroundColor as HexColor
      overrides["markdown-code-block"] = input.foregroundColor as HexColor
    }
    if (input.diffAddColor) {
      overrides["icon-diff-add-base"] = input.diffAddColor as HexColor
      overrides["icon-diff-add-hover"] = input.diffAddColor as HexColor
      overrides["icon-diff-add-active"] = input.diffAddColor as HexColor
      overrides["syntax-diff-add"] = input.diffAddColor as HexColor
    }
    if (input.diffDeleteColor) {
      overrides["icon-diff-delete-base"] = input.diffDeleteColor as HexColor
      overrides["icon-diff-delete-hover"] = input.diffDeleteColor as HexColor
      overrides["syntax-diff-delete"] = input.diffDeleteColor as HexColor
    }
    if (input.diffAddText) {
      overrides["text-diff-add-base"] = input.diffAddText as HexColor
    } else if (input.diffAddColor) {
      overrides["text-diff-add-base"] = input.diffAddColor as HexColor
    }
    if (input.diffDeleteText) {
      overrides["text-diff-delete-base"] = input.diffDeleteText as HexColor
    } else if (input.diffDeleteColor) {
      overrides["text-diff-delete-base"] = input.diffDeleteColor as HexColor
    }
    if (input.diffAddStrong) {
      overrides["text-diff-add-strong"] = input.diffAddStrong as HexColor
    }
    if (input.diffDeleteStrong) {
      overrides["text-diff-delete-strong"] = input.diffDeleteStrong as HexColor
    }
    if (input.diffModifiedColor) {
      overrides["icon-diff-modified-base"] = input.diffModifiedColor as HexColor
      overrides["syntax-diff-unknown"] = input.diffModifiedColor as HexColor
    }
    variant.overrides = Object.keys(overrides).length ? overrides : undefined
  }

  return next
}

function activeVariant(theme: DesktopTheme | null, mode: "light" | "dark") {
  if (!theme) return
  return mode === "dark" ? theme.dark : theme.light
}

function activeTokens(theme: DesktopTheme | null, mode: "light" | "dark") {
  const variant = activeVariant(theme, mode)
  if (!variant) return null
  return resolveThemeVariant(variant, mode === "dark")
}

function range(input: number, low: number, high: number) {
  return low + (high - low) * (input / 100)
}

function pivot(input: number, low: number, mid: number, high: number) {
  if (input <= 50) return range(input * 2, low, mid)
  return range((input - 50) * 2, mid, high)
}

function syncTheme(theme: ReturnType<typeof useTheme>, input: AppearanceOverrides, applied: Set<string>) {
  const base = theme.themes()[theme.themeId()]
  if (!base) return
  const mode = theme.mode()
  const before = activeTokens(base, mode)
  const after = activeTokens(withOverrides(base, input), mode)
  const next = new Set<string>()
  const apply = (key: string, value: string) => {
    document.documentElement.style.setProperty(key, value)
    next.add(key)
  }
  const fallback = (value: string, base: string) => value || base

  if (before && after) {
    for (const [key, value] of Object.entries(after)) {
      if (before[key] === value) continue
      apply(`--${key}`, value)
    }
  }

  if (input.diffTint !== 50) {
    const light = Math.round(pivot(input.diffTint, 96, 88, 72))
    const dark = Math.round(pivot(input.diffTint, 94, 80, 58))
    const lightNum = Math.round(pivot(input.diffTint, 98, 91, 80))
    const darkNum = Math.round(pivot(input.diffTint, 96, 85, 68))
    const lightHover = Math.round(pivot(input.diffTint, 94, 80, 60))
    const darkHover = Math.round(pivot(input.diffTint, 90, 75, 50))
    const lightEmphasis = pivot(input.diffTint, 0.04, 0.15, 0.32).toFixed(3)
    const darkEmphasis = pivot(input.diffTint, 0.06, 0.2, 0.38).toFixed(3)
    apply(
      "--diffs-bg-addition-override",
      `light-dark(color-mix(in lab, var(--diffs-bg) ${light}%, var(--diffs-addition-base)), color-mix(in lab, var(--diffs-bg) ${dark}%, var(--diffs-addition-base)))`,
    )
    apply(
      "--diffs-bg-deletion-override",
      `light-dark(color-mix(in lab, var(--diffs-bg) ${light}%, var(--diffs-deletion-base)), color-mix(in lab, var(--diffs-bg) ${dark}%, var(--diffs-deletion-base)))`,
    )
    apply(
      "--diffs-bg-addition-number-override",
      `light-dark(color-mix(in lab, var(--diffs-bg) ${lightNum}%, var(--diffs-addition-base)), color-mix(in lab, var(--diffs-bg) ${darkNum}%, var(--diffs-addition-base)))`,
    )
    apply(
      "--diffs-bg-deletion-number-override",
      `light-dark(color-mix(in lab, var(--diffs-bg) ${lightNum}%, var(--diffs-deletion-base)), color-mix(in lab, var(--diffs-bg) ${darkNum}%, var(--diffs-deletion-base)))`,
    )
    apply(
      "--diffs-bg-addition-hover-override",
      `light-dark(color-mix(in lab, var(--diffs-bg) ${lightHover}%, var(--diffs-addition-base)), color-mix(in lab, var(--diffs-bg) ${darkHover}%, var(--diffs-addition-base)))`,
    )
    apply(
      "--diffs-bg-deletion-hover-override",
      `light-dark(color-mix(in lab, var(--diffs-bg) ${lightHover}%, var(--diffs-deletion-base)), color-mix(in lab, var(--diffs-bg) ${darkHover}%, var(--diffs-deletion-base)))`,
    )
    apply(
      "--diffs-bg-addition-emphasis-override",
      `light-dark(rgb(from var(--diffs-addition-base) r g b / ${lightEmphasis}), rgb(from var(--diffs-addition-base) r g b / ${darkEmphasis}))`,
    )
    apply(
      "--diffs-bg-deletion-emphasis-override",
      `light-dark(rgb(from var(--diffs-deletion-base) r g b / ${lightEmphasis}), rgb(from var(--diffs-deletion-base) r g b / ${darkEmphasis}))`,
    )
    apply(
      "--surface-diff-add-base",
      `light-dark(color-mix(in lab, var(--background-base) ${Math.round(range(input.diffTint, 97, 78))}%, var(--syntax-diff-add)), color-mix(in lab, var(--background-base) ${Math.round(range(input.diffTint, 94, 70))}%, var(--syntax-diff-add)))`,
    )
    apply(
      "--surface-diff-add-weak",
      `light-dark(color-mix(in lab, var(--background-base) ${Math.round(range(input.diffTint, 99, 86))}%, var(--syntax-diff-add)), color-mix(in lab, var(--background-base) ${Math.round(range(input.diffTint, 97, 76))}%, var(--syntax-diff-add)))`,
    )
    apply(
      "--surface-diff-add-weaker",
      `light-dark(color-mix(in lab, var(--background-base) ${Math.round(range(input.diffTint, 100, 92))}%, var(--syntax-diff-add)), color-mix(in lab, var(--background-base) ${Math.round(range(input.diffTint, 95, 82))}%, var(--syntax-diff-add)))`,
    )
    apply(
      "--surface-diff-add-strong",
      `light-dark(color-mix(in lab, var(--background-base) ${Math.round(range(input.diffTint, 93, 64))}%, var(--syntax-diff-add)), color-mix(in lab, var(--background-base) ${Math.round(range(input.diffTint, 88, 52))}%, var(--syntax-diff-add)))`,
    )
    apply(
      "--surface-diff-add-stronger",
      `light-dark(color-mix(in lab, var(--background-base) ${Math.round(range(input.diffTint, 82, 28))}%, var(--syntax-diff-add)), color-mix(in lab, var(--background-base) ${Math.round(range(input.diffTint, 70, 20))}%, var(--syntax-diff-add)))`,
    )
    apply(
      "--surface-diff-delete-base",
      `light-dark(color-mix(in lab, var(--background-base) ${Math.round(range(input.diffTint, 97, 78))}%, var(--syntax-diff-delete)), color-mix(in lab, var(--background-base) ${Math.round(range(input.diffTint, 94, 70))}%, var(--syntax-diff-delete)))`,
    )
    apply(
      "--surface-diff-delete-weak",
      `light-dark(color-mix(in lab, var(--background-base) ${Math.round(range(input.diffTint, 99, 86))}%, var(--syntax-diff-delete)), color-mix(in lab, var(--background-base) ${Math.round(range(input.diffTint, 97, 76))}%, var(--syntax-diff-delete)))`,
    )
    apply(
      "--surface-diff-delete-weaker",
      `light-dark(color-mix(in lab, var(--background-base) ${Math.round(range(input.diffTint, 100, 92))}%, var(--syntax-diff-delete)), color-mix(in lab, var(--background-base) ${Math.round(range(input.diffTint, 95, 82))}%, var(--syntax-diff-delete)))`,
    )
    apply(
      "--surface-diff-delete-strong",
      `light-dark(color-mix(in lab, var(--background-base) ${Math.round(range(input.diffTint, 93, 64))}%, var(--syntax-diff-delete)), color-mix(in lab, var(--background-base) ${Math.round(range(input.diffTint, 88, 52))}%, var(--syntax-diff-delete)))`,
    )
    apply(
      "--surface-diff-delete-stronger",
      `light-dark(color-mix(in lab, var(--background-base) ${Math.round(range(input.diffTint, 82, 28))}%, var(--syntax-diff-delete)), color-mix(in lab, var(--background-base) ${Math.round(range(input.diffTint, 70, 20))}%, var(--syntax-diff-delete)))`,
    )
  }

  if (input.diffModifiedColor) {
    apply("--diffs-modified-color-override", input.diffModifiedColor)
  } else {
    apply("--diffs-modified-color-override", "var(--syntax-diff-unknown)")
  }

  if (input.diffAddColor) {
    apply("--diffs-addition-color-override", input.diffAddColor)
  } else {
    apply("--diffs-addition-color-override", "var(--syntax-diff-add)")
  }

  if (input.diffDeleteColor) {
    apply("--diffs-deletion-color-override", input.diffDeleteColor)
  } else {
    apply("--diffs-deletion-color-override", "var(--syntax-diff-delete)")
  }

  if (input.diffAddText || input.diffAddColor) {
    apply("--diffs-addition-text-override", fallback(input.diffAddText, input.diffAddColor))
  }

  if (input.diffDeleteText || input.diffDeleteColor) {
    apply("--diffs-deletion-text-override", fallback(input.diffDeleteText, input.diffDeleteColor))
  }

  if (input.diffAddStrong || input.diffAddText || input.diffAddColor) {
    apply("--diffs-addition-text-strong-override", fallback(input.diffAddStrong, fallback(input.diffAddText, input.diffAddColor)))
  }

  if (input.diffDeleteStrong || input.diffDeleteText || input.diffDeleteColor) {
    apply(
      "--diffs-deletion-text-strong-override",
      fallback(input.diffDeleteStrong, fallback(input.diffDeleteText, input.diffDeleteColor)),
    )
  }

  if (input.diffTint === 50 && !input.diffAddColor && !input.diffDeleteColor && !input.diffModifiedColor) {
    next.delete("--diffs-modified-color-override")
    next.delete("--diffs-addition-color-override")
    next.delete("--diffs-deletion-color-override")
    document.documentElement.style.removeProperty("--diffs-modified-color-override")
    document.documentElement.style.removeProperty("--diffs-addition-color-override")
    document.documentElement.style.removeProperty("--diffs-deletion-color-override")
  }

  for (const key of applied) {
    if (next.has(key)) continue
    document.documentElement.style.removeProperty(key)
  }

  applied.clear()
  for (const key of next) {
    applied.add(key)
  }
}

export const AppearanceSync: Component = () => {
  const theme = useTheme()
  const [overrides, setOverrides] = createSignal(loadOverrides())
  const applied = new Set<string>()

  const refresh = () => setOverrides(loadOverrides())
  const sync = () => refresh()
  const storage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) refresh()
  }

  createEffect(() => {
    theme.themeId()
    theme.mode()
    syncTheme(theme, overrides(), applied)
  })

  window.addEventListener(STORAGE_EVENT, sync)
  window.addEventListener("storage", storage)

  onCleanup(() => {
    window.removeEventListener(STORAGE_EVENT, sync)
    window.removeEventListener("storage", storage)
    for (const key of applied) {
      document.documentElement.style.removeProperty(key)
    }
  })

  return null
}

export const SettingsAppearance: Component = () => {
  const theme = useTheme()
  const language = useLanguage()
  const settings = useSettings()

  const [overrides, setOverrides] = createStore(loadOverrides())
  const [importing, setImporting] = createSignal(false)

  createEffect(() => {
    saveOverrides({ ...overrides })
  })

  createEffect(() => {
    document.documentElement.style.setProperty("--font-size-base", `${overrides.uiFontSize}px`)
  })

  createEffect(() => {
    document.documentElement.classList.toggle("use-pointer-cursors", overrides.pointerCursors)
  })

  createEffect(() => {
    document.documentElement.classList.toggle("translucent-sidebar", overrides.translucentSidebar)
  })

  onMount(() => {
    void theme.loadThemes()
  })

  const current = createMemo(() => theme.themes()[theme.themeId()] ?? null)
  const preview = createMemo(() => {
    const base = current()
    if (!base) return null
    return withOverrides(base, overrides)
  })
  const tokens = createMemo(() => activeTokens(preview(), theme.mode()))
  const variant = createMemo(() => activeVariant(preview(), theme.mode()))

  const themeOptions = createMemo(() => theme.ids().map((id) => ({ id, name: theme.name(id) })))

  const colorSchemeOptions = createMemo((): { value: ColorScheme; label: string }[] => [
    { value: "system", label: language.t("theme.scheme.system") },
    { value: "light", label: language.t("theme.scheme.light") },
    { value: "dark", label: language.t("theme.scheme.dark") },
  ])

  const accentDisplay = createMemo(() => primary(variant()!))
  const bgDisplay = createMemo(() => neutral(variant()!))
  const fgDisplay = createMemo(() => ink(variant()!) ?? read(tokens(), "text-base")!)
  const diffAddDisplay = createMemo(() => diffAdd(variant()!) ?? read(tokens(), "text-diff-add-base")!)
  const diffDeleteDisplay = createMemo(() => diffDelete(variant()!) ?? read(tokens(), "text-diff-delete-base")!)
  const diffModifiedDisplay = createMemo(
    () => read(tokens(), "icon-diff-modified-base") ?? read(tokens(), "syntax-diff-unknown")!,
  )
  const diffAddTextDisplay = createMemo(() => read(tokens(), "text-diff-add-base")!)
  const diffDeleteTextDisplay = createMemo(() => read(tokens(), "text-diff-delete-base")!)
  const diffAddStrongDisplay = createMemo(() => read(tokens(), "text-diff-add-strong")!)
  const diffDeleteStrongDisplay = createMemo(() => read(tokens(), "text-diff-delete-strong")!)

  const hasThemeOverrides = createMemo(
    () => !!(overrides.accentColor || overrides.backgroundColor || overrides.foregroundColor || overrides.contrast !== 50),
  )
  const hasDiffOverrides = createMemo(
    () =>
      !!(
        overrides.diffAddColor ||
        overrides.diffDeleteColor ||
        overrides.diffModifiedColor ||
        overrides.diffAddText ||
        overrides.diffDeleteText ||
        overrides.diffAddStrong ||
        overrides.diffDeleteStrong ||
        overrides.diffTint !== 50
      ),
  )

  const resetTheme = () => {
    setOverrides("accentColor", "")
    setOverrides("backgroundColor", "")
    setOverrides("foregroundColor", "")
    setOverrides("contrast", 50)
  }

  const resetDiff = () => {
    setOverrides("diffAddColor", "")
    setOverrides("diffDeleteColor", "")
    setOverrides("diffModifiedColor", "")
    setOverrides("diffAddText", "")
    setOverrides("diffDeleteText", "")
    setOverrides("diffAddStrong", "")
    setOverrides("diffDeleteStrong", "")
    setOverrides("diffTint", 50)
  }

  const handleImport = async () => {
    const input = prompt("Enter a theme URL or paste theme JSON:")
    if (!input?.trim()) return
    setImporting(true)
    try {
      const item = input.trim().startsWith("{")
        ? (JSON.parse(input.trim()) as DesktopTheme)
        : await loadThemeFromUrl(input.trim())
      if (!item.id || !item.light || !item.dark) {
        showToast({ variant: "error", title: "Invalid theme", description: "Missing required fields (id, light, dark)" })
        return
      }
      saveStoredTheme(item)
      theme.registerTheme(item)
      theme.setTheme(item.id)
      phCapture("theme_imported", { themeId: item.id })
      showToast({ variant: "success", title: "Theme imported", description: item.name || item.id })
    } catch (err) {
      showToast({
        variant: "error",
        title: "Import failed",
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setImporting(false)
    }
  }

  const handleCopyTheme = async () => {
    const item = preview()
    if (!item) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(item, null, 2))
      showToast({ variant: "success", title: "Theme copied to clipboard" })
    } catch {
      showToast({ variant: "error", title: "Failed to copy theme" })
    }
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-raised-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 pt-6 pb-8">
          <h2 class="text-16-medium text-text-strong">Appearance</h2>
        </div>
      </div>

      <div class="flex flex-col gap-8 w-full">
        <div class="flex flex-col gap-1">
          <div class="flex items-center justify-between pb-2">
            <h3 class="text-14-medium text-text-strong">Theme</h3>
            <div class="flex items-center gap-2">
              <Show when={hasThemeOverrides()}>
                <Button size="small" variant="ghost" onClick={resetTheme}>
                  Reset
                </Button>
              </Show>
              <Button size="small" variant="ghost" onClick={handleImport} disabled={importing()}>
                {importing() ? "Importing..." : "Import"}
              </Button>
              <Button size="small" variant="ghost" onClick={handleCopyTheme}>
                Copy theme
              </Button>
            </div>
          </div>

          <div class="bg-surface-raised-base px-4 rounded-lg">
            <SettingsRow
              title={language.t("settings.general.row.appearance.title")}
              description={language.t("settings.general.row.appearance.description")}
            >
              <Select
                data-action="settings-color-scheme"
                options={colorSchemeOptions()}
                current={colorSchemeOptions().find((item) => item.value === theme.colorScheme())}
                value={(item) => item.value}
                label={(item) => item.label}
                onSelect={(item) => {
                  if (!item) return
                  phCapture("setting_changed", { setting: "color_scheme", value: item.value })
                  theme.setColorScheme(item.value)
                }}
                onHighlight={(item) => {
                  if (!item) return
                  theme.previewColorScheme(item.value)
                  return () => theme.cancelPreview()
                }}
                variant="secondary"
                size="small"
                triggerVariant="settings"
              />
            </SettingsRow>

            <SettingsRow
              title={language.t("settings.general.row.theme.title")}
              description={
                <>
                  {language.t("settings.general.row.theme.description")}{" "}
                  <Link href="https://opencode.ai/docs/themes/">{language.t("common.learnMore")}</Link>
                </>
              }
            >
              <Select
                data-action="settings-theme"
                options={themeOptions()}
                current={themeOptions().find((item) => item.id === theme.themeId())}
                value={(item) => item.id}
                label={(item) => item.name}
                onSelect={(item) => {
                  if (!item) return
                  phCapture("setting_changed", { setting: "theme", value: item.id })
                  theme.setTheme(item.id)
                }}
                onHighlight={(item) => {
                  if (!item) return
                  theme.previewTheme(item.id)
                  return () => theme.cancelPreview()
                }}
                variant="secondary"
                size="small"
                triggerVariant="settings"
              />
            </SettingsRow>

            <SettingsRow title="Accent" description="Primary accent color">
              <ColorPicker value={accentDisplay()} onChange={(value) => setOverrides("accentColor", value)} />
            </SettingsRow>

            <SettingsRow title="Background" description="Base background color">
              <ColorPicker value={bgDisplay()} onChange={(value) => setOverrides("backgroundColor", value)} />
            </SettingsRow>

            <SettingsRow title="Foreground" description="Base text color">
              <ColorPicker value={fgDisplay()} onChange={(value) => setOverrides("foregroundColor", value)} />
            </SettingsRow>

            <SettingsRow title="Contrast" description="Adjust contrast without changing the selected base theme">
              <div class="flex items-center gap-3">
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={overrides.contrast}
                  onInput={(event) => setOverrides("contrast", parseInt(event.currentTarget.value))}
                  class="w-36 h-1.5 accent-[var(--button-primary-base)] rounded-full appearance-none bg-border-base cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-text-strong [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-background-base [&::-webkit-slider-thumb]:shadow-sm"
                />
                <span class="text-13-medium text-text-base w-6 text-right tabular-nums">{overrides.contrast}</span>
              </div>
            </SettingsRow>
          </div>
        </div>

        <div class="flex flex-col gap-1">
          <div class="flex items-center justify-between pb-2">
            <h3 class="text-14-medium text-text-strong">Diff Colors</h3>
            <Show when={hasDiffOverrides()}>
              <Button size="small" variant="ghost" onClick={resetDiff}>
                Reset
              </Button>
            </Show>
          </div>

          <div class="bg-surface-raised-base px-4 rounded-lg">
            <SettingsRow title="Added" description="Color used for diff additions">
              <ColorPicker value={diffAddDisplay()} onChange={(value) => setOverrides("diffAddColor", value)} />
            </SettingsRow>

            <SettingsRow title="Deleted" description="Color used for diff deletions">
              <ColorPicker value={diffDeleteDisplay()} onChange={(value) => setOverrides("diffDeleteColor", value)} />
            </SettingsRow>

            <SettingsRow title="Modified" description="Color used for modified diff markers">
              <ColorPicker value={diffModifiedDisplay()} onChange={(value) => setOverrides("diffModifiedColor", value)} />
            </SettingsRow>

            <SettingsRow title="Added text" description="Text color used for added lines and inline additions">
              <ColorPicker value={diffAddTextDisplay()} onChange={(value) => setOverrides("diffAddText", value)} />
            </SettingsRow>

            <SettingsRow title="Deleted text" description="Text color used for deleted lines and inline deletions">
              <ColorPicker value={diffDeleteTextDisplay()} onChange={(value) => setOverrides("diffDeleteText", value)} />
            </SettingsRow>

            <SettingsRow title="Added emphasis text" description="Stronger text color used for emphasized additions">
              <ColorPicker value={diffAddStrongDisplay()} onChange={(value) => setOverrides("diffAddStrong", value)} />
            </SettingsRow>

            <SettingsRow title="Deleted emphasis text" description="Stronger text color used for emphasized deletions">
              <ColorPicker value={diffDeleteStrongDisplay()} onChange={(value) => setOverrides("diffDeleteStrong", value)} />
            </SettingsRow>

            <SettingsRow title="Background tint" description="Control how soft or strong the diff line background tint feels">
              <div class="flex items-center gap-3">
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={overrides.diffTint}
                  onInput={(event) => setOverrides("diffTint", parseInt(event.currentTarget.value))}
                  class="w-36 h-1.5 accent-[var(--button-primary-base)] rounded-full appearance-none bg-border-base cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-text-strong [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-background-base [&::-webkit-slider-thumb]:shadow-sm"
                />
                <span class="text-13-medium text-text-base w-6 text-right tabular-nums">{overrides.diffTint}</span>
              </div>
            </SettingsRow>
          </div>
        </div>

        <div class="flex flex-col gap-1">
          <h3 class="text-14-medium text-text-strong pb-2">Font</h3>

          <div class="bg-surface-raised-base px-4 rounded-lg">
            <SettingsRow
              title={language.t("settings.general.row.font.title")}
              description={language.t("settings.general.row.font.description")}
            >
              <Select
                data-action="settings-font"
                options={[...fontOptions]}
                current={fontOptions.find((item) => item.value === settings.appearance.font())}
                value={(item) => item.value}
                label={(item) => language.t(item.label)}
                onSelect={(item) => {
                  if (!item) return
                  phCapture("setting_changed", { setting: "font", value: item.value })
                  settings.appearance.setFont(item.value)
                }}
                variant="secondary"
                size="small"
                triggerVariant="settings"
                triggerStyle={{ "font-family": monoFontFamily(settings.appearance.font()), "min-width": "180px" }}
              >
                {(item) => (
                  <span style={{ "font-family": monoFontFamily(item?.value) }}>
                    {item ? language.t(item.label) : ""}
                  </span>
                )}
              </Select>
            </SettingsRow>

            <SettingsRow title="Code font size" description="Adjust the base size used for code across chats and diffs">
              <Select
                data-action="settings-font-size"
                options={FONT_SIZE_OPTIONS}
                current={FONT_SIZE_OPTIONS.find((item) => item.value === settings.appearance.fontSize())}
                value={(item) => String(item.value)}
                label={(item) => item.label}
                onSelect={(item) => {
                  if (!item) return
                  phCapture("setting_changed", { setting: "font_size", value: item.value })
                  settings.appearance.setFontSize(item.value)
                }}
                variant="secondary"
                size="small"
                triggerVariant="settings"
              />
            </SettingsRow>

            <SettingsRow title="UI font size" description="Adjust the base size used for the UI">
              <Select
                data-action="settings-ui-font-size"
                options={FONT_SIZE_OPTIONS}
                current={FONT_SIZE_OPTIONS.find((item) => item.value === overrides.uiFontSize)}
                value={(item) => String(item.value)}
                label={(item) => item.label}
                onSelect={(item) => {
                  if (!item) return
                  phCapture("setting_changed", { setting: "ui_font_size", value: item.value })
                  setOverrides("uiFontSize", item.value)
                }}
                variant="secondary"
                size="small"
                triggerVariant="settings"
              />
            </SettingsRow>
          </div>
        </div>

        <div class="flex flex-col gap-1">
          <h3 class="text-14-medium text-text-strong pb-2">Interface</h3>

          <div class="bg-surface-raised-base px-4 rounded-lg">
            <SettingsRow title="Translucent sidebar" description="Apply a translucent blur effect to the sidebar">
              <Switch
                checked={overrides.translucentSidebar}
                onChange={(checked) => {
                  phCapture("setting_changed", { setting: "translucent_sidebar", value: checked })
                  setOverrides("translucentSidebar", checked)
                }}
              />
            </SettingsRow>

            <SettingsRow title="Use pointer cursors" description="Change the cursor to a pointer when hovering over interactive elements">
              <Switch
                checked={overrides.pointerCursors}
                onChange={(checked) => {
                  phCapture("setting_changed", { setting: "pointer_cursors", value: checked })
                  setOverrides("pointerCursors", checked)
                }}
              />
            </SettingsRow>
          </div>
        </div>
      </div>
    </div>
  )
}

function ColorPicker(props: { value: string; onChange: (value: string) => void }) {
  let ref!: HTMLInputElement

  return (
    <button
      type="button"
      class="flex items-center gap-2 h-8 px-3 rounded-md border border-border-base text-13-medium cursor-pointer hover:border-border-hover transition-colors"
      style={{ "min-width": "140px" }}
      onClick={() => ref.click()}
    >
      <span class="w-5 h-5 rounded-full border border-border-weak-base shrink-0" style={{ "background-color": props.value }} />
      <span class="text-text-strong uppercase">{props.value}</span>
      <input
        ref={ref}
        type="color"
        value={props.value}
        onInput={(event) => props.onChange(event.currentTarget.value)}
        class="sr-only"
      />
    </button>
  )
}

interface SettingsRowProps {
  title: string
  description: string | JSX.Element
  children: JSX.Element
}

const SettingsRow: Component<SettingsRowProps> = (props) => {
  return (
    <div class="flex flex-wrap items-center justify-between gap-4 py-3 border-b border-border-weak-base last:border-none">
      <div class="flex flex-col gap-0.5 min-w-0">
        <span class="text-14-medium text-text-strong">{props.title}</span>
        <span class="text-12-regular text-text-weak">{props.description}</span>
      </div>
      <div class="flex-shrink-0">{props.children}</div>
    </div>
  )
}
