import { For, Show, type Accessor, type JSX } from "solid-js"
import { COMPOSER_MENU_CLASS } from "./menu-metrics"
import type { PermissionModeGroups, PermissionModeRow } from "../permission/permission-mode"
import {
  type PermissionModeOption,
} from "../permission/modes"
import { ClaxedoIcon as Icon, ClaxedoIconV2 as BareIcon, DropdownMenu, Tooltip } from "@/ui"

export function PromptPermissionControl(props: {
  enabled: Accessor<boolean>
  disabled: Accessor<boolean>
  style: Accessor<JSX.CSSProperties>
  groups: Accessor<PermissionModeGroups | undefined>
  current: Accessor<PermissionModeOption | undefined>
  label: string
  onSelect: (option: PermissionModeOption) => void
}) {
  const triggerText = () => props.current()?.name ?? "Permissions"
  const shieldActive = () => props.current() !== undefined

  return (
    <Show when={props.enabled()}>
      <DropdownMenu placement="top-start" gutter={8} fitViewport>
        <Tooltip
          placement="top"
          value={props.current()?.description ?? props.groups()?.harness.unavailable ?? props.label}
        >
          <DropdownMenu.Trigger
            data-action="prompt-permission-mode"
            data-mode={props.current()?.id ?? ""}
            type="button"
            aria-label={triggerText()}
            disabled={props.disabled()}
            tabIndex={props.disabled() ? -1 : undefined}
            style={props.style()}
            class="flex h-7 min-w-0 shrink items-center gap-1.5 rounded-md px-2.5 text-compact font-body leading-4 transition-colors duration-150 hover:bg-v2-overlay-simple-overlay-hover disabled:pointer-events-none disabled:opacity-50 data-[expanded]:bg-v2-overlay-simple-overlay-hover"
            classList={{
              "text-v2-text-text-base": shieldActive(),
              "text-v2-text-text-faint hover:text-v2-text-text-muted": !shieldActive(),
            }}
          >
            <Icon
              name="shield"
              size="small"
              class="shrink-0"
              classList={{
                "text-v2-icon-icon-base": shieldActive(),
                "text-v2-icon-icon-muted": !shieldActive(),
              }}
            />
            <span data-slot="composer-control-label" class="truncate">{triggerText()}</span>
          </DropdownMenu.Trigger>
        </Tooltip>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            class={`${COMPOSER_MENU_CLASS} overflow-y-auto`}
            style={{ "max-height": "min(420px, var(--kb-popper-content-available-height, 420px))" }}
          >
            <Show when={props.groups()} fallback={<DropdownMenu.Item disabled>Resolving harness…</DropdownMenu.Item>}>
              {(groups) => (
                <>
                  <Show
                    when={groups().harness.rows.length > 0}
                    fallback={
                      <p
                        class="text-balance px-2.5 py-2 text-sm leading-[var(--line-height-prose-compact)] text-v2-text-text-faint"
                      >
                        {groups().harness.unavailable}
                      </p>
                    }
                  >
                    <DropdownMenu.Group>
                      <DropdownMenu.GroupLabel>{groups().harness.label}</DropdownMenu.GroupLabel>
                      <For each={groups().harness.rows}>
                        {(item) => <ModeRow row={item} current={props.current} onSelect={props.onSelect} />}
                      </For>
                    </DropdownMenu.Group>
                  </Show>
                </>
              )}
            </Show>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>
    </Show>
  )
}

export function permissionRowText(row: PermissionModeRow) {
  const detail = [row.option.description, row.blockedReason].filter(Boolean).join(" — ")
  return { detail, caveat: row.option.caveat }
}

function ModeRow(props: {
  row: PermissionModeRow
  current: Accessor<PermissionModeOption | undefined>
  onSelect: (option: PermissionModeOption) => void
}) {
  const option = () => props.row.option
  const selected = () => props.current()?.id === option().id
  const text = () => permissionRowText(props.row)
  const detail = () => text().detail
  const caveat = () => text().caveat

  return (
    <DropdownMenu.Item
      data-permission-mode-row
      data-mode={option().id}
      data-what={option().delivery.kind}
      data-selectable={props.row.selectable ? "true" : "false"}
      data-checked={selected() ? "true" : undefined}
      aria-checked={selected()}
      class="w-full"
      disabled={!props.row.selectable}
      onSelect={() => props.row.selectable && props.onSelect(option())}
    >
      <span class="flex w-full min-w-0 items-start gap-2">
        <Icon
          name="shield"
          size="small"
          class="translate-y-px shrink-0 transition-[color] duration-150 ease-[cubic-bezier(0.2,0,0,1)]"
          classList={{
            "text-v2-icon-icon-base": selected(),
            "text-v2-icon-icon-muted": !selected(),
          }}
        />
        <span class="flex min-w-0 flex-1 flex-col gap-0.5">
          <span data-slot="menu-v2-item-content" class="text-compact leading-4 text-v2-text-text-base">
            {option().name}
          </span>
          <Show when={detail()}>
            <span
              class="whitespace-normal text-xs leading-[var(--line-height-15)] text-v2-text-text-faint"
            >
              {detail()}
            </span>
          </Show>
          <Show when={caveat()}>
            <span
              class="whitespace-normal text-xs leading-[var(--line-height-15)]"
              style={{ color: "var(--v2-state-fg-warning)" }}
            >
              {caveat()}
            </span>
          </Show>
        </span>
        <span
          data-slot="menu-v2-item-indicator"
          data-checked={selected() ? "true" : undefined}
          aria-hidden="true"
          class="mt-0.5 shrink-0"
        >
          <BareIcon name="check-small" size="small" />
        </span>
      </span>
    </DropdownMenu.Item>
  )
}
