import { Avatar } from "@opencode-ai/ui/avatar"
import { For, Show } from "solid-js"
import { useProjectsText } from "../i18n"
import { getAvatarColors } from "../project-avatar"
import { AVATAR_COLOR_KEYS } from "../project-colors"
import { ClaxedoIcon as Icon } from "@/ui"

export type IconFieldState = { iconUrl: string; iconHover: boolean; dragOver: boolean; color: string; label: string }

export function ProjectIconField(props: {
  state: IconFieldState
  onHover: (hover: boolean) => void
  onDrop: (event: DragEvent) => void
  onDragOver: (event: DragEvent) => void
  onDragLeave: () => void
  onClear: () => void
  onInputChange: (event: Event) => void
}) {
  const t = useProjectsText()
  return (
    <div class="flex flex-col gap-2">
      <label class="text-12-medium text-text-weak">{t("projects.edit.icon")}</label>
      <div class="flex gap-3 items-start">
        <div class="relative" onMouseEnter={() => props.onHover(true)} onMouseLeave={() => props.onHover(false)}>
          <div
            class="relative size-16 rounded-md transition-colors cursor-pointer"
            classList={{
              "border-text-interactive-base bg-surface-info-base/20": props.state.dragOver,
              "border-border-base hover:border-border-strong-base": !props.state.dragOver,
              "overflow-hidden": !!props.state.iconUrl,
            }}
            onDrop={(event) => props.onDrop(event)}
            onDragOver={(event) => props.onDragOver(event)}
            onDragLeave={() => props.onDragLeave()}
            onClick={() => {
              if (props.state.iconUrl && props.state.iconHover) props.onClear()
              else document.getElementById("icon-upload")?.click()
            }}
          >
            <Show
              when={props.state.iconUrl}
              fallback={
                <div class="size-full flex items-center justify-center">
                  <Avatar fallback={props.state.label} {...getAvatarColors(props.state.color)} class="size-full text-4xl" />
                </div>
              }
            >
              <img src={props.state.iconUrl} alt={t("projects.edit.icon.alt")} class="size-full object-cover" />
            </Show>
          </div>
          <div
            class="absolute inset-0 size-16 bg-surface-raised-stronger-non-alpha/90 rounded-md z-10 pointer-events-none flex items-center justify-center transition-opacity"
            classList={{
              "opacity-100": props.state.iconHover && !props.state.iconUrl,
              "opacity-0": !(props.state.iconHover && !props.state.iconUrl),
            }}
          >
            <Icon name="cloud-upload" size="large" class="text-icon-on-interactive-base drop-shadow-sm" />
          </div>
          <div
            class="absolute inset-0 size-16 bg-surface-raised-stronger-non-alpha/90 rounded-md z-10 pointer-events-none flex items-center justify-center transition-opacity"
            classList={{
              "opacity-100": props.state.iconHover && !!props.state.iconUrl,
              "opacity-0": !(props.state.iconHover && !!props.state.iconUrl),
            }}
          >
            <Icon name="trash" size="large" class="text-icon-on-interactive-base drop-shadow-sm" />
          </div>
        </div>
        <input id="icon-upload" type="file" accept="image/*" class="hidden" onChange={(event) => props.onInputChange(event)} />
        <div class="flex flex-col gap-1.5 text-12-regular text-text-weak self-center">
          <span>{t("projects.edit.icon.hint")}</span>
          <span>{t("projects.edit.icon.recommended")}</span>
        </div>
      </div>
    </div>
  )
}

export function ProjectColorField(props: { color: string; label: string; onColor: (color: string) => void }) {
  const t = useProjectsText()
  return (
    <div class="flex flex-col gap-2">
      <label class="text-12-medium text-text-weak">{t("projects.edit.color")}</label>
      <div class="flex gap-1.5">
        <For each={AVATAR_COLOR_KEYS}>
          {(color) => (
            <button
              type="button"
              aria-label={t("projects.edit.color.select", { color })}
              aria-pressed={props.color === color}
              classList={{
                "flex items-center justify-center size-10 p-0.5 rounded-lg overflow-hidden transition-colors cursor-default": true,
                "bg-transparent border-2 border-icon-strong-base hover:bg-surface-base-hover": props.color === color,
                "bg-transparent border border-transparent hover:bg-surface-base-hover hover:border-border-weak-base": props.color !== color,
              }}
              onClick={() => props.onColor(color)}
            >
              <Avatar fallback={props.label} {...getAvatarColors(color)} class="size-full rounded" />
            </button>
          )}
        </For>
      </div>
    </div>
  )
}
