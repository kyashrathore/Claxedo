import { createSimpleContext } from "@opencode-ai/ui/context"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { type Accessor, createComputed, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import { useLanguage } from "@/platform/i18n/provider"
import { useSettings } from "@/platform/settings/provider"
import { dict as en } from "@/platform/i18n/en"
import { Persist, persisted } from "@/platform/persistence/persist"

const IS_MAC = typeof navigator === "object" && /(Mac|iPod|iPhone|iPad)/.test(navigator.platform)

const PALETTE_ID = "command.palette"
const DEFAULT_PALETTE_KEYBIND = "mod+shift+p"
const SUGGESTED_PREFIX = "suggested."
const EDITABLE_KEYBIND_IDS = new Set(["terminal.toggle", "terminal.new", "file.attach"])

type KeyLabel =
  | "common.key.ctrl"
  | "common.key.alt"
  | "common.key.shift"
  | "common.key.meta"
  | "common.key.space"
  | "common.key.backspace"
  | "common.key.enter"
  | "common.key.tab"
  | "common.key.delete"
  | "common.key.home"
  | "common.key.end"
  | "common.key.pageUp"
  | "common.key.pageDown"
  | "common.key.insert"
  | "common.key.esc"

function keyText(key: KeyLabel, t?: (key: KeyLabel) => string) {
  return t ? t(key) : en[key]
}

function actionId(id: string) {
  if (!id.startsWith(SUGGESTED_PREFIX)) return id
  return id.slice(SUGGESTED_PREFIX.length)
}

export function createCoalescedMicrotask(task: () => void) {
  let queued = false
  let disposed = false
  return {
    schedule() {
      if (queued || disposed) return
      queued = true
      queueMicrotask(() => {
        queued = false
        if (!disposed) task()
      })
    },
    dispose() {
      disposed = true
    },
  }
}

function normalizeKey(key: string) {
  if (key === ",") return "comma"
  if (key === "+") return "plus"
  if (key === " ") return "space"
  return key.toLowerCase()
}

function signature(key: string, ctrl: boolean, meta: boolean, shift: boolean, alt: boolean) {
  const mask = (ctrl ? 1 : 0) | (meta ? 2 : 0) | (shift ? 4 : 0) | (alt ? 8 : 0)
  return `${key}:${mask}`
}

function signatureFromEvent(event: KeyboardEvent) {
  return signature(normalizeKey(event.key), event.ctrlKey, event.metaKey, event.shiftKey, event.altKey)
}

function isAllowedEditableKeybind(id: string | undefined) {
  if (!id) return false
  return EDITABLE_KEYBIND_IDS.has(actionId(id))
}

export type KeybindConfig = string

export interface Keybind {
  key: string
  ctrl: boolean
  meta: boolean
  shift: boolean
  alt: boolean
}

export interface CommandOption {
  id: string
  title: string
  description?: string
  category?: string
  keybind?: KeybindConfig
  slash?: string
  suggested?: boolean
  disabled?: boolean
  hidden?: boolean
  onSelect?: (source?: "palette" | "keybind" | "slash") => void
  onHighlight?: () => (() => void) | void
}

type CommandSource = "palette" | "keybind" | "slash"

export type CommandCatalogItem = {
  title: string
  description?: string
  category?: string
  keybind?: KeybindConfig
  slash?: string
  hidden?: boolean
}

export type CommandRegistration = {
  key?: string
  options: Accessor<CommandOption[]>
}

export function upsertCommandRegistration(registrations: CommandRegistration[], entry: CommandRegistration) {
  if (entry.key === undefined) return [entry, ...registrations]
  return [entry, ...registrations.filter((x) => x.key !== entry.key)]
}

export type CommandRegistrationProjection = {
  all: CommandOption[]
  ids: ReadonlySet<string>
  slash: CommandOption[]
}

/** One canonical index shared by dispatch and exact keybind lookup. Suggested
 * aliases point at their base command, while the base row wins when both are
 * present (the same ordering contract as the palette's rendered options). */
export function indexCommandOptions(options: readonly CommandOption[]) {
  const index = new Map<string, CommandOption>()
  for (const option of options) {
    index.set(option.id, option)
    index.set(actionId(option.id), option)
  }
  return index
}

/**
 * Build the command catalog's canonical deduplicated projection once. Consumers
 * that need only command presence or slash commands must not rescan the full
 * catalog (which can contain thousands of extension-provided commands).
 */
export function projectCommandRegistrations(
  registrations: readonly CommandRegistration[],
  onDuplicate?: (id: string) => void,
): CommandRegistrationProjection {
  const ids = new Set<string>()
  const all: CommandOption[] = []
  const slash: CommandOption[] = []

  for (const registration of registrations) {
    for (const option of registration.options()) {
      if (ids.has(option.id)) {
        onDuplicate?.(option.id)
        continue
      }
      ids.add(option.id)
      all.push(option)
      if (option.slash && !option.disabled && !option.id.startsWith(SUGGESTED_PREFIX)) slash.push(option)
    }
  }

  return { all, ids, slash }
}

/**
 * Exact-ID reactive presence. The catalog topology is broad, but a consumer of
 * `has("project.open")` is notified only when that ID appears or disappears.
 */
export function createCommandPresence(ids: Accessor<ReadonlySet<string>>) {
  const entries = new Map<string, ReturnType<typeof createSignal<boolean>>>()
  // Provider setup runs outside a reactive listener. Capture the current
  // projection here so creating a keyed presence signal inside a consumer
  // never subscribes that consumer to the whole command catalog.
  let current: ReadonlySet<string> = ids()

  createComputed(() => {
    const next = ids()
    current = next
    for (const [id, [, setPresent]] of entries) setPresent(next.has(id))
  })

  return (id: string) => {
    let entry = entries.get(id)
    if (!entry) {
      entry = createSignal(current.has(id))
      entries.set(id, entry)
    }
    return entry[0]()
  }
}

// The effective keybind the command palette displays next to a command: a
// user's custom rebind (settings.keybinds) wins over the command's registered
// default, and the "none" sentinel (or an empty override) means "no binding" so
// the palette shows nothing rather than a stale default. Exported so the
// discoverability contract — palette lists the ACTIVE binding, not the default —
// is unit-testable without mounting the whole command context.
export function resolveEffectiveKeybind(
  custom: string | undefined,
  registeredDefault: KeybindConfig | undefined,
): KeybindConfig | undefined {
  const config = custom ?? registeredDefault
  if (!config || config === "none") return undefined
  return config
}

export function parseKeybind(config: string): Keybind[] {
  if (!config || config === "none") return []

  return config.split(",").map((combo) => {
    const parts = combo.trim().toLowerCase().split("+")
    const keybind: Keybind = {
      key: "",
      ctrl: false,
      meta: false,
      shift: false,
      alt: false,
    }

    for (const part of parts) {
      switch (part) {
        case "ctrl":
        case "control":
          keybind.ctrl = true
          break
        case "meta":
        case "cmd":
        case "command":
          keybind.meta = true
          break
        case "mod":
          if (IS_MAC) keybind.meta = true
          else keybind.ctrl = true
          break
        case "alt":
        case "option":
          keybind.alt = true
          break
        case "shift":
          keybind.shift = true
          break
        default:
          keybind.key = part
          break
      }
    }

    return keybind
  })
}

export function matchKeybind(keybinds: Keybind[], event: KeyboardEvent): boolean {
  const eventKey = normalizeKey(event.key)

  for (const kb of keybinds) {
    const keyMatch = kb.key === eventKey
    const ctrlMatch = kb.ctrl === (event.ctrlKey || false)
    const metaMatch = kb.meta === (event.metaKey || false)
    const shiftMatch = kb.shift === (event.shiftKey || false)
    const altMatch = kb.alt === (event.altKey || false)

    if (keyMatch && ctrlMatch && metaMatch && shiftMatch && altMatch) {
      return true
    }
  }

  return false
}

function displayKeybindParts(kb: Keybind, t?: (key: KeyLabel) => string) {
  const parts: string[] = []

  if (kb.ctrl) parts.push(IS_MAC ? "⌃" : keyText("common.key.ctrl", t))
  if (kb.alt) parts.push(IS_MAC ? "⌥" : keyText("common.key.alt", t))
  if (kb.shift) parts.push(IS_MAC ? "⇧" : keyText("common.key.shift", t))
  if (kb.meta) parts.push(IS_MAC ? "⌘" : keyText("common.key.meta", t))

  if (!kb.key) return parts

  const keys: Record<string, string> = {
    arrowup: "↑",
    arrowdown: "↓",
    arrowleft: "←",
    arrowright: "→",
    comma: ",",
    plus: "+",
  }
  const named: Record<string, KeyLabel> = {
    backspace: "common.key.backspace",
    delete: "common.key.delete",
    end: "common.key.end",
    enter: "common.key.enter",
    esc: "common.key.esc",
    escape: "common.key.esc",
    home: "common.key.home",
    insert: "common.key.insert",
    pagedown: "common.key.pageDown",
    pageup: "common.key.pageUp",
    space: "common.key.space",
    tab: "common.key.tab",
  }
  const key = kb.key.toLowerCase()
  const displayKey =
    keys[key] ??
    (named[key]
      ? keyText(named[key], t)
      : key.length === 1
        ? key.toUpperCase()
        : key.charAt(0).toUpperCase() + key.slice(1))
  parts.push(displayKey)

  return parts
}

export function formatKeybindParts(config: string, t?: (key: KeyLabel) => string): string[] {
  if (!config || config === "none") return []
  const keybind = parseKeybind(config)[0]
  return keybind ? displayKeybindParts(keybind, t) : []
}

export function formatKeybind(config: string, t?: (key: KeyLabel) => string): string {
  const parts = formatKeybindParts(config, t)
  if (parts.length === 0) return ""
  return IS_MAC ? parts.join("") : parts.join("+")
}

// KeybindV2 takes an array instead of a string
export function formatKeybindKeys(config: string, t?: (key: KeyLabel) => string): string[] {
  return formatKeybindParts(config, t)
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target.closest("[contenteditable='true']")) return true
  if (target.closest("input, textarea, select")) return true
  return false
}

const commandContextInput = {
  name: "Command", gate: true,
  init: () => {
    const dialog = useDialog()
    const settings = useSettings()
    const language = useLanguage()
    const [store, setStore] = createStore({
      registrations: [] as CommandRegistration[],
      suspendCount: 0,
    })
    const warnedDuplicates = new Set<string>()

    type CommandCatalog = Record<string, CommandCatalogItem>
    const [catalog, setCatalog, _, catalogReady] = persisted(
      Persist.global("command.catalog.v1"),
      createStore<CommandCatalog>({}),
    )

    const bind = (id: string, def: KeybindConfig | undefined) =>
      resolveEffectiveKeybind(settings.keybinds.get(actionId(id)), def)

    const registered = createMemo(() =>
      projectCommandRegistrations(store.registrations, (id) => {
        if (!import.meta.env.DEV || warnedDuplicates.has(id)) return
        warnedDuplicates.add(id)
        console.warn(`[command] duplicate command id "${id}" registered; keeping first entry`)
      }),
    )
    const has = createCommandPresence(() => registered().ids)

    const syncCatalog = createCoalescedMicrotask(() => {
      if (!catalogReady()) return
      setCatalog(
        registered().all.reduce((acc, opt) => {
          const id = actionId(opt.id)
          if (opt.title)
            acc[id] = {
              title: opt.title,
              description: opt.description,
              category: opt.category,
              keybind: opt.keybind,
              slash: opt.slash,
            }
          return acc
        }, {} as CommandCatalog),
      )
    })
    onCleanup(syncCatalog.dispose)
    createEffect(() => {
      if (!catalogReady()) return
      // Track topology, then collapse a synchronous mount/unmount burst into
      // one projection of the latest registration graph.
      store.registrations
      syncCatalog.schedule()
    })

    const catalogOptions = createMemo(() => Object.entries(catalog).map(([id, meta]) => ({ id, ...meta })))

    const options = createMemo(() => {
      const resolved = registered().all.map((opt) => ({
        ...opt,
        keybind: bind(opt.id, opt.keybind),
      }))

      const suggested = resolved.filter((x) => x.suggested && !x.disabled)

      return [
        ...suggested.map((x) => ({
          ...x,
          id: SUGGESTED_PREFIX + x.id,
          category: language.t("command.category.suggested"),
        })),
        ...resolved,
      ]
    })

    // The composer consumes only slash commands. Deriving them from the
    // canonical projection avoids resolving keybinds and filtering every
    // palette/extension command again whenever command topology changes.
    const slashOptions = createMemo(() =>
      registered().slash.map((opt) => ({
        ...opt,
        keybind: bind(opt.id, opt.keybind),
      })),
    )

    const suspended = () => store.suspendCount > 0

    const palette = createMemo(() => {
      const config = settings.keybinds.get(PALETTE_ID) ?? DEFAULT_PALETTE_KEYBIND
      const keybinds = parseKeybind(config)
      return new Set(keybinds.map((kb) => signature(kb.key, kb.ctrl, kb.meta, kb.shift, kb.alt)))
    })

    const keymap = createMemo(() => {
      const map = new Map<string, CommandOption>()
      for (const option of options()) {
        if (option.id.startsWith(SUGGESTED_PREFIX)) continue
        if (option.disabled) continue
        if (!option.keybind) continue

        const keybinds = parseKeybind(option.keybind)
        for (const kb of keybinds) {
          if (!kb.key) continue
          const sig = signature(kb.key, kb.ctrl, kb.meta, kb.shift, kb.alt)
          if (map.has(sig)) continue
          map.set(sig, option)
        }
      }
      return map
    })

    const optionMap = createMemo(() => {
      return indexCommandOptions(options())
    })

    const run = (id: string, source?: CommandSource) => {
      const option = optionMap().get(id)
      option?.onSelect?.(source)
    }

    const showPalette = () => {
      run("file.open", "palette")
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (suspended() || dialog.active) return

      const sig = signatureFromEvent(event)
      const isPalette = palette().has(sig)
      const option = keymap().get(sig)
      const modified = event.ctrlKey || event.metaKey || event.altKey
      const isTab = event.key === "Tab"

      if (isEditableTarget(event.target) && !isPalette && !isAllowedEditableKeybind(option?.id) && !modified && !isTab)
        return

      if (isPalette) {
        event.preventDefault()
        showPalette()
        return
      }

      if (!option) return
      event.preventDefault()
      option.onSelect?.("keybind")
    }

    onMount(() => {
      makeEventListener(document, "keydown", handleKeyDown)
    })

    function register(cb: () => CommandOption[]): void
    function register(key: string, cb: () => CommandOption[]): void
    function register(key: string | (() => CommandOption[]), cb?: () => CommandOption[]) {
      const id = typeof key === "string" ? key : undefined
      const next = typeof key === "function" ? key : cb
      if (!next) return
      const options = createMemo(next)
      const entry: CommandRegistration = {
        key: id,
        options,
      }
      setStore("registrations", (arr) => upsertCommandRegistration(arr, entry))
      onCleanup(() => {
        setStore("registrations", (arr) => arr.filter((x) => x !== entry))
      })
    }

    const keybindConfig = (id: string) => {
      if (id === PALETTE_ID) return settings.keybinds.get(PALETTE_ID) ?? DEFAULT_PALETTE_KEYBIND
      const base = actionId(id)
      return optionMap().get(base)?.keybind ?? bind(base, catalog[base]?.keybind)
    }

    return {
      register,
      trigger(id: string, source?: CommandSource) {
        run(id, source)
      },
      keybind(id: string) {
        const config = keybindConfig(id)
        if (!config) return ""
        return formatKeybind(config, language.t)
      },
      keybindParts(id: string) {
        const config = keybindConfig(id)
        return config ? formatKeybindParts(config, language.t) : []
      },
      show: showPalette,
      keybinds(enabled: boolean) {
        setStore("suspendCount", (count) => Math.max(0, count + (enabled ? -1 : 1)))
      },
      suspended,
      get catalog() {
        return catalogOptions()
      },
      get options() {
        return options()
      },
      get slashOptions() {
        return slashOptions()
      },
      has(id: string) {
        return has(id)
      },
    }
  },
}
export const { use: useCommand, provider: CommandProvider } = createSimpleContext<ReturnType<typeof commandContextInput.init>, Record<string, any>>(commandContextInput)
