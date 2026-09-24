import { Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { createHoverEngagement } from "../hover-engagement"
import { dictionary } from "../i18n"
import type { ProjectSection } from "../project-sections"

export type ProjectHeaderProps = {
  readonly section: ProjectSection
  readonly open: boolean
  readonly active: boolean
  readonly onToggle: () => void
  readonly onSelect: () => void
  readonly onNewSession: () => void
  readonly onNewTerminal: () => void
}

function activateFromKeyboard(event: KeyboardEvent, action: () => void) {
  if (event.key !== "Enter" && event.key !== " ") return
  event.preventDefault()
  event.stopPropagation()
  action()
}

function Disclosure(props: { readonly open: boolean; readonly active: boolean; readonly onToggle: () => void }): JSX.Element {
  const t = useTranslator(dictionary)
  return (
    <span
      data-icon-interaction="binary"
      data-icon-state={props.open ? "open" : "closed"}
      class="size-4 shrink-0 flex items-center justify-center relative"
      role="button"
      tabIndex={0}
      classList={{ "text-text-strong": props.active, "text-text-base/85": !props.active }}
      aria-label={props.open ? t("rail.collapseProject") : t("rail.expandProject")}
      aria-expanded={props.open}
      onClick={(event) => {
        event.stopPropagation()
        props.onToggle()
      }}
      onKeyDown={(event) => activateFromKeyboard(event, props.onToggle)}
    >
      <Icon name={props.open ? "folder-open" : "folder"} size="small" class="shrink-0 absolute inset-0 m-auto transition-colors duration-100" />
    </span>
  )
}

const ACTION_CLASS = "flex items-center justify-center size-6 rounded text-icon-base hover:text-text-base hover:bg-surface-base-active transition-colors"

function HeaderActions(props: { readonly label: string; readonly engaged: boolean; readonly onNewSession: () => void; readonly onNewTerminal: () => void }): JSX.Element {
  const t = useTranslator(dictionary)
  return (
    <div
      data-icon-interaction="row-actions"
      class="flex items-center gap-0.5 shrink-0 opacity-0 group-hover/header:opacity-100 focus-within:opacity-100 transition-opacity duration-150"
      style={{ width: "3.125rem", height: "1.5rem" }}
      onClick={(event) => event.stopPropagation()}
    >
      <Show when={props.engaged}>
        <Tooltip placement="top" value={t("rail.newSessionTooltip")}>
          <button
            type="button"
            class={ACTION_CLASS}
            aria-label={t("rail.newSessionIn", { project: props.label })}
            onClick={(event) => {
              event.stopPropagation()
              props.onNewSession()
            }}
          >
            <Icon name="plus-small" size="small" />
          </button>
        </Tooltip>
        <Tooltip placement="top" value={t("rail.newTerminalTooltip")}>
          <button
            type="button"
            class={ACTION_CLASS}
            aria-label={t("rail.newTerminalIn", { project: props.label })}
            data-testid="rail-new-terminal"
            data-scope="project"
            onClick={(event) => {
              event.stopPropagation()
              props.onNewTerminal()
            }}
          >
            <Icon name="terminal" size="small" />
          </button>
        </Tooltip>
      </Show>
    </div>
  )
}

export function ProjectHeader(props: ProjectHeaderProps): JSX.Element {
  const engagement = createHoverEngagement({ releaseDelayMs: 150 })
  return (
    <div
      data-testid="project-header"
      data-slot="project-header"
      data-active={props.active ? "true" : "false"}
      data-cloud-disconnected={props.section.dimmed ? "true" : undefined}
      class="flex items-center gap-2 min-h-8 pl-3 pr-2.5 py-1 mx-1 group/header cursor-pointer hover:bg-surface-base-hover/30 rounded-md transition-[colors,opacity] duration-100"
      classList={{ "opacity-60 hover:opacity-100": props.section.dimmed }}
      {...engagement.handlers}
      onClick={() => props.onSelect()}
    >
      <div class="flex items-center gap-1.5 min-w-0 flex-1">
        <Disclosure open={props.open} active={props.active} onToggle={props.onToggle} />
        <span
          title={props.section.caption}
          class="text-compact font-medium truncate min-w-0"
          classList={{ "text-text-strong": props.active, "text-text-base/85": !props.active }}
        >
          {props.section.label}
        </span>
      </div>
      <Show when={props.section.placementId}>
        <HeaderActions label={props.section.label} engaged={engagement.engaged()} onNewSession={props.onNewSession} onNewTerminal={props.onNewTerminal} />
      </Show>
    </div>
  )
}
