import { createMemo, For, Show, type Component } from "solid-js"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import {
  DISCOVERY_LABEL,
  HARNESS_LABEL,
  KIND_LABEL,
  type CatalogEntry,
  type DiscoveredExtension,
  type DiscoveredExtensionAction,
  type InstallStatus,
  type MachineDiscoveredItem,
  type MachineHarness,
} from "./install-flow"

export const MachineSection: Component<{
  items: MachineDiscoveredItem[]
  totalCount: number
  search: string
  onDelete: (item: MachineDiscoveredItem) => void
  deleting: Record<string, boolean>
}> = (props) => {
  const grouped = createMemo(() => {
    const buckets = new Map<MachineHarness, MachineDiscoveredItem[]>()
    for (const item of props.items) {
      const list = buckets.get(item.harness) ?? []
      list.push(item)
      buckets.set(item.harness, list)
    }
    return [...buckets.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
  })

  return (
    <section class="flex flex-col gap-4">
      <div class="flex items-baseline justify-between">
        <div class="flex flex-col">
          <h2 class="text-[13px] font-semibold tracking-tight text-text-strong">On this machine</h2>
          <p class="text-[11px] text-text-weaker">
            {props.search
              ? `${props.items.length} of ${props.totalCount} matching "${props.search}"`
              : `${props.totalCount} skill${props.totalCount === 1 ? "" : "s"} and plugins discovered across Claude, Codex, Cursor, and Agents.`}
          </p>
        </div>
      </div>
      <Show
        when={props.items.length > 0}
        fallback={
          <div class="grid place-items-center rounded-md border border-dashed border-border-weak-base/40 px-6 py-12 text-text-weak">
            <span class="text-[12px]">
              {props.search ? "No machine items match the search." : "No skills detected under ~/.claude, ~/.codex, ~/.cursor, or ~/.agents."}
            </span>
          </div>
        }
      >
        <For each={grouped()}>
          {([harness, items]) => (
            <div class="flex flex-col gap-2">
              <div class="flex items-baseline gap-2 px-1">
                <h3 class="text-[12px] font-medium text-text-base">{HARNESS_LABEL[harness]}</h3>
                <span class="text-[10px] text-text-weaker">{items.length}</span>
              </div>
              <div class="grid grid-cols-1 gap-1 lg:grid-cols-2">
                <For each={items}>
                  {(item) => (
                    <MachineCard
                      item={item}
                      onDelete={() => props.onDelete(item)}
                      deleting={props.deleting[`${item.harness}/${item.kind}/${item.name}`] ?? false}
                    />
                  )}
                </For>
              </div>
            </div>
          )}
        </For>
      </Show>
    </section>
  )
}

export const MachineCard: Component<{
  item: MachineDiscoveredItem
  onDelete: () => void
  deleting: boolean
}> = (props) => {
  const shortPath = createMemo(() => {
    const home = props.item.path
    return home.replace(/^\/Users\/[^/]+/, "~")
  })
  return (
    <div class="group/machine relative flex items-center gap-3 rounded-md border border-border-weak-base/30 bg-surface-raised-base/20 px-3 py-2.5 transition-colors hover:border-border-weak-base/60 hover:bg-surface-raised-base/40">
      <div class="grid size-7 shrink-0 place-items-center rounded bg-surface-base text-[12px] text-text-weak">
        {props.item.kind === "skill" ? "📘" : props.item.kind === "mcp" ? "🔌" : "🧩"}
      </div>
      <div class="min-w-0 flex-1">
        <div class="flex items-baseline gap-2">
          <span class="truncate text-[12px] font-medium text-text-strong">{props.item.name}</span>
          <span class="shrink-0 rounded bg-surface-base px-1.5 py-px text-[9px] uppercase tracking-wider text-text-weak">
            {props.item.kind === "native-plugin" ? "Plugin" : props.item.kind === "mcp" ? "MCP" : "Skill"}
          </span>
        </div>
        <div class="mt-0.5 truncate font-mono text-[10px] text-text-weaker">{shortPath()}</div>
      </div>
      <span class="flex h-6 shrink-0 items-center gap-1 rounded border border-border-weak-base/40 bg-surface-base px-1.5 text-[10px] font-medium text-text-weak group-hover/machine:hidden">
        <Icon name="check-small" size="small" class="text-icon-success-base" />
        Local
      </span>
      <button
        type="button"
        class="hidden h-6 shrink-0 items-center gap-1 rounded border border-border-weak-base/40 bg-surface-base px-1.5 text-[10px] font-medium text-text-weak transition-colors hover:border-border-critical-base hover:bg-surface-critical-base/10 hover:text-text-on-critical-base disabled:opacity-60 group-hover/machine:flex"
        onClick={(event) => {
          event.stopPropagation()
          props.onDelete()
        }}
        disabled={props.deleting}
        title={`Delete ${props.item.path} from disk`}
      >
        <Icon name={props.deleting ? "dot-grid" : "trash"} size="small" class={props.deleting ? "animate-spin" : ""} />
        {props.deleting ? "Deleting…" : "Delete"}
      </button>
    </div>
  )
}

export const DiscoveredSection: Component<{
  items: DiscoveredExtension[]
  pending: Record<string, DiscoveredExtensionAction>
  onDismiss: () => void
  onAdopt: (item: DiscoveredExtension) => void
  onIgnore: (item: DiscoveredExtension) => void
}> = (props) => (
  <section class="mb-6 flex flex-col gap-2 rounded-md border border-border-weak-base/40 bg-surface-raised-base/30 px-4 py-3">
    <div class="flex items-baseline justify-between">
      <div class="flex flex-col">
        <h2 class="text-[13px] font-semibold tracking-tight text-text-strong">Already on this machine</h2>
        <p class="text-[11px] text-text-weaker">{props.items.length} item{props.items.length === 1 ? "" : "s"} detected in the active project.</p>
      </div>
      <button
        type="button"
        class="text-[11px] text-text-weak hover:text-text-base"
        onClick={props.onDismiss}
      >
        Dismiss
      </button>
    </div>
    <ul class="flex flex-col gap-1 pt-1">
      <For each={props.items}>
        {(item) => <DiscoveredRow item={item} pending={props.pending[item.path]} onAdopt={() => props.onAdopt(item)} onIgnore={() => props.onIgnore(item)} />}
      </For>
    </ul>
  </section>
)

const DiscoveredRow: Component<{
  item: DiscoveredExtension
  pending: DiscoveredExtensionAction | undefined
  onAdopt: () => void
  onIgnore: () => void
}> = (props) => {
  const isAdopted = () => props.item.state === "adopted"
  const isIgnored = () => props.item.state === "ignored"
  const isPending = () => props.pending !== undefined
  return (
    <li class="group/discovered flex items-center justify-between gap-3 rounded px-2 py-1.5 text-[12px] hover:bg-surface-base-hover/40">
      <div class="min-w-0 truncate font-mono text-text-base">{props.item.path}</div>
      <div class="flex shrink-0 items-center gap-2 text-[10px] text-text-weak">
        <span class="rounded bg-surface-base px-1.5 py-0.5 uppercase tracking-wider">{DISCOVERY_LABEL[props.item.kind]}</span>
        <span class="w-14 text-right group-hover/discovered:hidden" classList={{ "text-icon-success-base": isAdopted() }}>{props.item.state}</span>
        <div class="hidden items-center gap-1 group-hover/discovered:flex">
          <button
            type="button"
            class="flex h-6 items-center gap-1 rounded border border-border-weak-base/40 bg-surface-base px-1.5 text-[10px] font-medium text-text-base transition-colors hover:border-border-weak-base/80 hover:bg-surface-base-hover disabled:opacity-60"
            onClick={(event) => {
              event.stopPropagation()
              props.onAdopt()
            }}
            disabled={isPending() || isAdopted()}
            title="Adopt this config so Claxedo manages it"
          >
            <Icon name={props.pending === "adopt" ? "dot-grid" : "circle-check"} size="small" class={props.pending === "adopt" ? "animate-spin" : ""} />
            {isAdopted() ? "Adopted" : "Adopt"}
          </button>
          <button
            type="button"
            class="flex h-6 items-center gap-1 rounded border border-border-weak-base/40 bg-surface-base px-1.5 text-[10px] font-medium text-text-weak transition-colors hover:border-border-weak-base/80 hover:bg-surface-base-hover disabled:opacity-60"
            onClick={(event) => {
              event.stopPropagation()
              props.onIgnore()
            }}
            disabled={isPending() || isIgnored()}
            title="Ignore this config"
          >
            <Icon name={props.pending === "ignore" ? "dot-grid" : "circle-ban-sign"} size="small" class={props.pending === "ignore" ? "animate-spin" : ""} />
            {isIgnored() ? "Ignored" : "Ignore"}
          </button>
        </div>
      </div>
    </li>
  )
}

export const ExtensionCard: Component<{
  entry: CatalogEntry
  installed: boolean
  status: InstallStatus
  enabled: boolean
  toggling: boolean
  onInstall: () => void
  onUninstall: () => void
  onToggleEnablement: () => void
}> = (props) => {
  const scopeLabel = createMemo(() => {
    if (props.entry.recommendedScope === "machine") return "Machine"
    if (props.entry.recommendedScope === "project") return "Project"
    return "Cloud"
  })
  const sourceLabel = createMemo(() => {
    const value = props.entry.source
    if (value.startsWith("https://github.com/")) {
      return value.slice("https://github.com/".length)
    }
    return value
  })

  return (
    <div class="group flex items-start gap-3 rounded-md border border-border-weak-base/30 bg-surface-raised-base/20 px-3.5 py-3 transition-colors hover:border-border-weak-base/70 hover:bg-surface-raised-base/50">
      <div class="grid size-9 shrink-0 place-items-center rounded-md bg-surface-base text-[16px]">
        <Show
          when={props.entry.icon}
          fallback={
            // 4-square fallback icon for marketplace entries without package icons.
            // Matches the sidebar entry's grid-4 mark so the marketplace
            // brand is visually consistent across surfaces.
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.75"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="size-4 text-icon-weak-base"
              aria-hidden="true"
            >
              <rect x="3" y="3" width="7" height="7" rx="1.25" />
              <rect x="14" y="3" width="7" height="7" rx="1.25" />
              <rect x="3" y="14" width="7" height="7" rx="1.25" />
              <rect x="14" y="14" width="7" height="7" rx="1.25" />
            </svg>
          }
        >
          <span aria-hidden="true">{props.entry.icon}</span>
        </Show>
      </div>
      <div class="min-w-0 flex-1">
        <div class="flex items-baseline justify-between gap-3">
          <div class="min-w-0 flex-1">
            <div class="flex items-baseline gap-2">
              <span class="truncate text-[13px] font-medium text-text-strong">{props.entry.name}</span>
              <span class="shrink-0 rounded bg-surface-base px-1.5 py-px text-[9px] uppercase tracking-wider text-text-weak">
                {KIND_LABEL[props.entry.kind]}
              </span>
            </div>
            <div class="mt-0.5 line-clamp-1 text-[12px] text-text-weak">{props.entry.description}</div>
          </div>
          <InstallButton
            installed={props.installed}
            status={props.status}
            enabled={props.enabled}
            toggling={props.toggling}
            onClick={props.onInstall}
            onUninstall={props.onUninstall}
            onToggleEnablement={props.onToggleEnablement}
          />
        </div>
        <div class="mt-1.5 flex items-center gap-1.5 text-[10px] text-text-weaker">
          <span>{scopeLabel()}</span>
          <span class="text-text-weaker/60">·</span>
          <span class="truncate font-mono">{sourceLabel()}</span>
        </div>
      </div>
    </div>
  )
}

export const InstallButton: Component<{
  installed: boolean
  status: InstallStatus
  enabled: boolean
  toggling: boolean
  onClick: () => void
  onUninstall: () => void
  onToggleEnablement: () => void
}> = (props) => {
  const isInstalled = () => props.installed || props.status === "installed"
  const isInstalling = () => props.status === "installing"
  const isUninstalling = () => props.status === "uninstalling"
  const isDisabled = () => isInstalled() && !props.enabled

  return (
    <Show
      when={!isInstalled()}
      fallback={
        <div class="group/install relative flex shrink-0">
          <span
            class="flex h-7 items-center gap-1 rounded-md border border-border-weak-base/40 bg-surface-base px-2 text-[11px] font-medium text-text-base group-hover/install:hidden"
            classList={{ "text-text-weak": isDisabled() }}
          >
            <Icon
              name={isDisabled() ? "circle-ban-sign" : "check-small"}
              size="small"
              class={isDisabled() ? "text-icon-weak-base" : "text-icon-success-base"}
            />
            {isUninstalling() ? "Removing…" : isDisabled() ? "Disabled" : "Installed"}
          </span>
          <div class="hidden shrink-0 items-center gap-1 group-hover/install:flex">
            <button
              type="button"
              class="flex h-7 items-center gap-1 rounded-md border border-border-weak-base/40 bg-surface-base px-2 text-[11px] font-medium text-text-base transition-colors hover:border-border-weak-base/80 hover:bg-surface-base-hover disabled:opacity-60"
              onClick={(event) => {
                event.stopPropagation()
                props.onToggleEnablement()
              }}
              disabled={props.toggling || isUninstalling()}
              title={props.enabled ? "Disable without uninstalling" : "Re-enable this extension"}
            >
              <Icon
                name={props.toggling ? "dot-grid" : props.enabled ? "circle-ban-sign" : "circle-check"}
                size="small"
                class={props.toggling ? "animate-spin" : ""}
              />
              {props.toggling ? (props.enabled ? "Disabling…" : "Enabling…") : props.enabled ? "Disable" : "Enable"}
            </button>
            <button
              type="button"
              class="flex h-7 items-center gap-1 rounded-md border border-border-weak-base/40 bg-surface-base px-2 text-[11px] font-medium text-text-base transition-colors hover:border-border-critical-base hover:bg-surface-critical-base/10 hover:text-text-on-critical-base disabled:opacity-60"
              onClick={(event) => {
                event.stopPropagation()
                props.onUninstall()
              }}
              disabled={isUninstalling()}
              title="Uninstall this extension"
            >
              <Icon name={isUninstalling() ? "dot-grid" : "trash"} size="small" class={isUninstalling() ? "animate-spin" : ""} />
              {isUninstalling() ? "Removing…" : "Uninstall"}
            </button>
          </div>
        </div>
      }
    >
      <button
        type="button"
        class="h-7 shrink-0 rounded-md border border-border-weak-base/40 bg-surface-base px-3 text-[11px] font-medium text-text-base outline-none transition-colors hover:border-border-weak-base/80 hover:bg-surface-base-hover focus:outline-none disabled:opacity-60"
        onClick={(event) => {
          event.stopPropagation()
          props.onClick()
        }}
        disabled={isInstalling()}
      >
        {isInstalling() ? "Installing…" : "Install"}
      </button>
    </Show>
  )
}
