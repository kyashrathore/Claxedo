import { For, Show, type Accessor, type JSX } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { COMPOSER_MENU_CLASS } from "@/features/session/composer/ui/menu-metrics"
import type { PermissionModeGroups, PermissionModeRow } from "@/features/session/composer/permission-mode"
import type { PermissionModeOption } from "@/features/session/permission/modes"

/**
 * The composer's permission-mode picker.
 *
 * Two groups, and the split is the design: `Claxedo` holds the one mode we own
 * (Auto), `<Harness>` holds whatever that harness advertises, IN THE HARNESS'S OWN
 * WORDS. An earlier design mapped a single five-mode vocabulary onto every harness
 * and was dropped as lossy by construction — cursor-sdk has no permission surface at
 * all, pi cannot restrict ahead of time, Codex has no plan mode — so it named
 * capabilities that did not exist. Showing the harness's own names means the picker
 * cannot lie about what a mode does, because it is not paraphrasing.
 *
 * Three states are surfaced rather than hidden, because each is a different thing
 * and collapsing them is how a user comes to believe a policy is active when it is
 * not:
 *   - a harness that offers nothing shows WHY (`unavailable`), not an empty list;
 *   - a mode we cannot deliver yet is visible but NOT selectable, and says so;
 *   - a caveat that can withdraw a mode at runtime (Claude's auto needs a model that
 *     supports it, and org policy can still force prompts) rides on its row.
 *
 * `data-what` on each row carries the delivery kind — that is the honest answer to
 * "what does this map to in the harness", and it is what the tooltip explains.
 */
export function PromptPermissionControl(props: {
  enabled: Accessor<boolean>
  disabled: Accessor<boolean>
  style: Accessor<JSX.CSSProperties>
  /** Undefined while the harness is still resolving. */
  groups: Accessor<PermissionModeGroups | undefined>
  /** Undefined when the stored selection names a mode the harness no longer offers. */
  current: Accessor<PermissionModeOption | undefined>
  label: string
  onSelect: (option: PermissionModeOption) => void
}) {
  // Deliberately not "Auto" when unresolved: a stored mode the harness stopped
  // advertising must not wear Auto's label while a different selection is stored.
  const triggerText = () => props.current()?.name ?? "Permissions"
  const shieldActive = () => props.current() !== undefined

  return (
    <Show when={props.enabled()}>
      <MenuV2 placement="top-start" gutter={8} fitViewport>
        <Tooltip placement="top" value={props.current()?.description ?? props.label}>
          <MenuV2.Trigger
            data-action="prompt-permission-mode"
            data-mode={props.current()?.id ?? ""}
            type="button"
            aria-label={props.label}
            disabled={props.disabled()}
            tabIndex={props.disabled() ? -1 : undefined}
            style={props.style()}
            class="flex h-7 min-w-0 shrink items-center gap-1.5 rounded-md px-2.5 text-[13px] font-[440] leading-4 transition-colors duration-150 hover:bg-v2-overlay-simple-overlay-hover disabled:pointer-events-none disabled:opacity-50 data-[expanded]:bg-v2-overlay-simple-overlay-hover"
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
                "text-v2-icon-icon-accent": shieldActive(),
                "text-v2-icon-icon-muted": !shieldActive(),
              }}
            />
            <span class="truncate max-md:hidden">{triggerText()}</span>
          </MenuV2.Trigger>
        </Tooltip>
        <MenuV2.Portal>
          <MenuV2.Content
            class={`${COMPOSER_MENU_CLASS} overflow-y-auto`}
            style={{ "max-height": "min(420px, var(--kb-popper-content-available-height, 420px))" }}
          >
            <Show when={props.groups()} fallback={<MenuV2.Item disabled>Resolving harness…</MenuV2.Item>}>
              {(groups) => (
                <>
                  <MenuV2.Group>
                    <MenuV2.GroupLabel>Claxedo</MenuV2.GroupLabel>
                    <For each={groups().claxedo}>
                      {(item) => (
                        <ModeRow row={item} current={props.current} onSelect={props.onSelect} />
                      )}
                    </For>
                  </MenuV2.Group>
                  <MenuV2.Separator />
                  <MenuV2.Group>
                    <MenuV2.GroupLabel>{groups().harness.label}</MenuV2.GroupLabel>
                    <Show
                      when={groups().harness.rows.length > 0}
                      fallback={
                        // The reason, not an empty group. "cursor-sdk exposes no
                        // permission controls" is information; a blank list is a bug
                        // report waiting to happen.
                        <MenuV2.Item disabled>
                          <span class="text-v2-text-text-faint">{groups().harness.unavailable}</span>
                        </MenuV2.Item>
                      }
                    >
                      <For each={groups().harness.rows}>
                        {(item) => (
                          <ModeRow row={item} current={props.current} onSelect={props.onSelect} />
                        )}
                      </For>
                    </Show>
                  </MenuV2.Group>
                </>
              )}
            </Show>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
    </Show>
  )
}

function ModeRow(props: {
  row: PermissionModeRow
  current: Accessor<PermissionModeOption | undefined>
  onSelect: (option: PermissionModeOption) => void
}) {
  const option = () => props.row.option
  const selected = () => props.current()?.id === option().id
  // What this maps to in the harness, and any condition that can withdraw it. This
  // is the "learn more" content, inline rather than behind a second affordance.
  const detail = () => {
    const parts = [option().description, props.row.blockedReason, option().caveat].filter(Boolean)
    return parts.join(" — ")
  }

  return (
    <Tooltip placement="right" value={detail() || option().name}>
      <MenuV2.Item
        data-mode={option().id}
        data-what={option().delivery.kind}
        data-selectable={props.row.selectable ? "true" : "false"}
        disabled={!props.row.selectable}
        onSelect={() => props.row.selectable && props.onSelect(option())}
      >
        <span class="flex min-w-0 items-center gap-1.5">
          <Icon
            name="check"
            size="small"
            class="shrink-0"
            classList={{ "opacity-0": !selected(), "text-v2-icon-icon-accent": selected() }}
          />
          <span class="truncate">{option().name}</span>
        </span>
      </MenuV2.Item>
    </Tooltip>
  )
}
