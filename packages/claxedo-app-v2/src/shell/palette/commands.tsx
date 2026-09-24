import { createContext, createMemo, onCleanup, onMount, useContext, type JSX } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useTranslator } from "@/i18n"
import { isRecord } from "@/lib/record"
import { persistedStore, preferenceKey } from "@/lib/persisted"
import { useDialog } from "@/ui"
import { dictionary } from "../i18n"
import { useShellRegistries } from "../registries"
import { eventSignature, formatKeybind, formatKeybindParts, isEditableTarget, keybindSignature, parseKeybind, type KeyLabel } from "./keybinding"
import { OPEN_FILE_COMMAND } from "./palette-entries"
import {
  actionId,
  commandOwnerActive,
  indexOptions,
  projectRegistrations,
  resolveEffectiveKeybind,
  SUGGESTED_PREFIX,
  upsertRegistration,
  withSuggested,
  type CommandOption,
  type CommandOwner,
  type CommandRegistration,
  type CommandSource,
} from "./registrations"

export const PALETTE_ID = "shell.palette"
const DEFAULT_PALETTE_KEYBIND = "mod+shift+p"
const EDITABLE_KEYBIND_IDS = new Set(["terminal.toggle", "terminal.new", "file.attach"])

export type Commands = {
  readonly register: {
    (options: () => CommandOption[]): void
    (key: string, options: () => CommandOption[], opts?: { owner?: CommandOwner }): void
  }
  readonly trigger: (id: string, source?: CommandSource) => void
  readonly keybind: (id: string) => string
  readonly keybindParts: (id: string) => string[]
  readonly setKeybind: (id: string, config: string | undefined) => void
  readonly options: () => CommandOption[]
  readonly slashOptions: () => CommandOption[]
  readonly has: (id: string) => boolean
  readonly showPalette: () => void
  readonly keybinds: (enabled: boolean) => void
  readonly suspended: () => boolean
}

const CommandsContext = createContext<Commands>()

type Overrides = Record<string, string>

function readOverrides(value: unknown): Overrides | undefined {
  if (!isRecord(value)) return undefined
  const overrides: Overrides = {}
  for (const [id, config] of Object.entries(value)) if (typeof config === "string") overrides[id] = config
  return overrides
}

export function CommandsProvider(props: { readonly children: JSX.Element }): JSX.Element {
  const t = useTranslator(dictionary)
  const registries = useShellRegistries()
  const [store, setStore] = createStore({ registrations: [] as CommandRegistration[], suspendCount: 0 })
  const [overrides, setOverrides] = persistedStore<Overrides>(preferenceKey("keybinds"), {}, readOverrides)
  const dialog = useDialog()
  const reported = new Set<string>()
  const keyLabel = (key: KeyLabel) => t(`shell.key.${key}`)

  const registryOptions = createMemo<CommandOption[]>(() =>
    registries.commands
      .list()
      .filter((entry) => !entry.when || entry.when())
      .map((entry) => ({ id: entry.id, title: entry.title(), keybind: entry.keybinding, onSelect: () => void entry.run() })),
  )
  const registered = createMemo(() =>
    projectRegistrations([{ options: registryOptions }, ...store.registrations], (id) => {
      if (reported.has(id)) return
      reported.add(id)
      console.error(`Command id "${id}" is registered twice; the first entry stays`)
    }),
  )
  const bind = (id: string, fallback: string | undefined) => resolveEffectiveKeybind(overrides[actionId(id)], fallback)
  const options = createMemo(() =>
    withSuggested(registered().all.map((option) => ({ ...option, keybind: bind(option.id, option.keybind) })), t("shell.palette.suggested")),
  )
  const slashOptions = createMemo(() => registered().slash.map((option) => ({ ...option, keybind: bind(option.id, option.keybind) })))
  const optionIndex = createMemo(() => indexOptions(options()))
  const paletteSignatures = createMemo(() => new Set(parseKeybind(overrides[PALETTE_ID] ?? DEFAULT_PALETTE_KEYBIND).map(keybindSignature)))
  const keymap = createMemo(() => {
    const map = new Map<string, CommandOption>()
    for (const option of options()) {
      if (option.id.startsWith(SUGGESTED_PREFIX) || option.disabled || !option.keybind) continue
      for (const kb of parseKeybind(option.keybind)) if (kb.key && !map.has(keybindSignature(kb))) map.set(keybindSignature(kb), option)
    }
    return map
  })
  const suspended = () => store.suspendCount > 0

  const run = (id: string, source?: CommandSource) => optionIndex().get(id)?.onSelect?.(source)

  const onKeyDown = (event: KeyboardEvent) => {
    if (suspended() || dialog.active) return
    const signature = eventSignature(event)
    const isPalette = paletteSignatures().has(signature)
    const option = keymap().get(signature)
    const modified = event.ctrlKey || event.metaKey || event.altKey
    const editable = isEditableTarget(event.target)
    if (editable && !isPalette && !EDITABLE_KEYBIND_IDS.has(actionId(option?.id ?? "")) && !modified && event.key !== "Tab") return
    if (isPalette) {
      event.preventDefault()
      run(OPEN_FILE_COMMAND, "palette")
      return
    }
    if (!option) return
    event.preventDefault()
    option.onSelect?.("keybind")
  }
  onMount(() => {
    document.addEventListener("keydown", onKeyDown)
    onCleanup(() => document.removeEventListener("keydown", onKeyDown))
  })

  function register(options: () => CommandOption[]): void
  function register(key: string, options: () => CommandOption[], opts?: { owner?: CommandOwner }): void
  function register(key: string | (() => CommandOption[]), cb?: () => CommandOption[], opts?: { owner?: CommandOwner }): void {
    const next = typeof key === "function" ? key : cb
    if (!next) return
    const owner = opts?.owner
    const entry: CommandRegistration = {
      key: typeof key === "string" ? key : undefined,
      ...(owner ? { owner } : {}),
      options: createMemo(() => (commandOwnerActive(owner) ? next() : [])),
    }
    setStore("registrations", (all) => upsertRegistration(all, entry))
    onCleanup(() => setStore("registrations", (all) => all.filter((x) => x !== entry)))
  }

  const keybindConfig = (id: string) => (id === PALETTE_ID ? (overrides[PALETTE_ID] ?? DEFAULT_PALETTE_KEYBIND) : optionIndex().get(actionId(id))?.keybind)

  const commands: Commands = {
    register,
    trigger: run,
    keybind: (id) => formatKeybind(keybindConfig(id) ?? "", keyLabel),
    keybindParts: (id) => formatKeybindParts(keybindConfig(id) ?? "", keyLabel),
    setKeybind: (id, config) => {
      const next = { ...overrides }
      if (config === undefined) delete next[id]
      else next[id] = config
      setOverrides(reconcile(next))
    },
    options,
    slashOptions,
    has: (id) => registered().ids.has(id),
    showPalette: () => run(OPEN_FILE_COMMAND, "palette"),
    keybinds: (enabled) => setStore("suspendCount", (count) => Math.max(0, count + (enabled ? -1 : 1))),
    suspended,
  }
  return <CommandsContext.Provider value={commands}>{props.children}</CommandsContext.Provider>
}

export function useCommands(): Commands {
  const commands = useContext(CommandsContext)
  if (!commands) throw new Error("useCommands needs a CommandsProvider above it")
  return commands
}
