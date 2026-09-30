import { Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { railDictionary } from "../i18n"
import type { NavigationStatus } from "../model"
import type { SwitcherItem } from "../switcher-items"
import { NavigationStatusMark } from "./navigation-row"
import { ClaxedoIcon as Icon, type ClaxedoIconProps, ProjectAvatar } from "@/ui"

function orGlobal(value: string | undefined, global: string): string {
  return value?.trim() || global
}

export function SwitcherPrefixMark(props: { readonly item: SwitcherItem; readonly active: boolean }): JSX.Element {
  const t = useTranslator(railDictionary)
  return (
    <span
      aria-hidden="true"
      data-testid="switcher-identity"
      class="relative flex h-full w-5 shrink-0 items-center justify-center text-text-weaker transition-opacity duration-100"
      classList={{
        "opacity-55 group-hover:opacity-100 group-focus-within:opacity-100": !props.active && props.item.status === "idle",
        "opacity-100": props.active || props.item.status !== "idle",
      }}
    >
      <Show
        when={props.item.status === "working" || props.item.status === "background"}
        fallback={
          <>
            <ProjectAvatar data-switcher-project-avatar fallback={orGlobal(props.item.projectLabel, t("rail.global"))} variant="outline" class="size-4 shrink-0" />
            <Show when={props.item.status !== "idle"}>
              <span class="absolute bottom-[3px] right-0 flex rounded-full bg-background-base p-px">
                <NavigationStatusMark status={props.item.status} surface="switcher" />
              </span>
            </Show>
          </>
        }
      >
        <NavigationStatusMark status={props.item.status} surface="switcher" />
      </Show>
    </span>
  )
}

function MetadataRow(props: { readonly icon: ClaxedoIconProps["name"]; readonly label: string; readonly value?: string; readonly attention?: boolean }): JSX.Element {
  return (
    <Show when={props.value?.trim()}>
      {(text) => (
        <div class="grid min-h-[20px] grid-cols-[16px_64px_minmax(0,1fr)] items-center gap-x-2.5">
          <span class="flex items-center justify-center text-icon-weak-base">
            <Icon name={props.icon} size="small" />
          </span>
          <span class="text-xs text-text-weaker">{props.label}</span>
          <span class="min-w-0 truncate text-sm" classList={{ "text-text-base": !props.attention, "text-text-interactive-base": props.attention }} title={text()}>
            {text()}
          </span>
        </div>
      )}
    </Show>
  )
}

const STATUS_TEXT = { working: "rail.card.working", background: "rail.card.background", permission: "rail.card.waiting", error: "rail.card.failed" } as const

function statusKey(status: NavigationStatus) {
  return status === "idle" || status === "done" ? undefined : STATUS_TEXT[status]
}

export function SwitcherCard(props: { readonly item: SwitcherItem }): JSX.Element {
  const t = useTranslator(railDictionary)
  const project = () => orGlobal(props.item.projectLabel, t("rail.global"))
  return (
    <div class="switcher-metadata-card w-[320px] bg-[var(--overlay-surface)] p-3">
      <div class="mb-2.5 flex items-center gap-2.5">
        <ProjectAvatar fallback={project()} variant="outline" class="size-8 shrink-0" />
        <div class="min-w-0 flex-1">
          <div class="truncate text-compact font-semibold leading-tight text-text-base">{props.item.title.trim() || t("rail.untitled")}</div>
          <div class="mt-1 truncate text-xs leading-tight text-text-weaker">
            {project()} · {orGlobal(props.item.workspaceLabel, t("rail.global"))}
          </div>
        </div>
      </div>
      <div class="grid gap-y-0.5">
        <Show
          when={props.item.kind === "session"}
          fallback={
            <>
              <MetadataRow icon="folder" label={t("rail.card.project")} value={props.item.projectLabel} />
              <MetadataRow icon="monitor" label={t("rail.card.workspace")} value={props.item.workspaceLabel} />
            </>
          }
        >
          <MetadataRow
            icon="circle-half"
            label={t("rail.card.status")}
            value={(() => {
              const key = statusKey(props.item.status)
              return key ? t(key) : undefined
            })()}
            attention={props.item.status !== "working" && props.item.status !== "background"}
          />
        </Show>
      </div>
    </div>
  )
}
