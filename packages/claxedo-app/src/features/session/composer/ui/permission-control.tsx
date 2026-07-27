import { For, Show, type Accessor, type JSX } from "solid-js"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { COMPOSER_MENU_CLASS } from "@/features/session/composer/ui/menu-metrics"
import type { PermissionModeGroups, PermissionModeRow } from "@/features/session/composer/permission-mode"
import {
  CLAXEDO_ASK_ALWAYS_ID,
  type PermissionModeOption,
} from "@/features/session/permission/modes"
// `ClaxedoIconV2` renders a BARE <svg>; `ClaxedoIcon` wraps it in a div. The
// menu's indicator contract styles `[data-slot="menu-v2-item-indicator"] > svg`,
// so the wrapped variant leaves the check unstyled — visible on every row.
import { ClaxedoIcon as Icon, ClaxedoIconV2 as BareIcon } from "@/ui/controls/claxedo-icon"

/**
 * The composer's permission-mode picker.
 *
 * ONE flat list, and which list it is depends on who enforces: a harness that
 * advertises modes contributes all of them, IN THE HARNESS'S OWN WORDS, and
 * Claxedo contributes nothing; a harness that advertises none gets Claxedo's own
 * two options instead. An earlier design mapped a single five-mode vocabulary onto
 * every harness and was dropped as lossy by construction — cursor-sdk has no
 * permission surface at all, pi cannot restrict ahead of time, Codex has no plan
 * mode — so it named capabilities that did not exist. Showing the harness's own
 * names means the picker cannot lie about what a mode does, because it is not
 * paraphrasing.
 *
 * A later design opened on a single collapsed Claxedo "Auto" row with the
 * harness's real modes behind a "N more …" disclosure. It is gone: Auto was only
 * ever a label over whichever row carried `level: "auto"`, and on Claude that row
 * is itself named "Auto" — so the menu opened on a paraphrase of a row it was
 * hiding, and put the actual list one click away for nothing.
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
  // Deliberately not a mode name when unresolved: a stored mode the harness
  // stopped advertising must not wear another row's label.
  const triggerText = () => props.current()?.name ?? "Permissions"
  const shieldActive = () => props.current() !== undefined

  return (
    <Show when={props.enabled()}>
      <MenuV2 placement="top-start" gutter={8} fitViewport>
        {/*
          Falls back to the REASON before the generic label. On a harness with no
          modes the trigger has no description to show, and "Permissions" alone
          invites a click that opens a menu with nothing to pick — saying why on
          hover answers the question without one.
        */}
        <Tooltip
          placement="top"
          value={props.current()?.description ?? props.groups()?.harness.unavailable ?? props.label}
        >
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
                "text-v2-icon-icon-base": shieldActive(),
                "text-v2-icon-icon-muted": !shieldActive(),
              }}
            />
            <span data-slot="composer-control-label" class="truncate">{triggerText()}</span>
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
                  {/*
                    Claxedo's own options, which exist ONLY where the harness
                    reported none — so this and the harness group below never
                    render together, and no group label is needed to tell them
                    apart.
                  */}
                  <For each={groups().claxedo}>
                    {(item) => <ModeRow row={item} current={props.current} onSelect={props.onSelect} />}
                  </For>
                  {/*
                    A REASON is prose, not a row.

                    This was a `MenuV2.Item disabled`, and menu items are a
                    fixed-height single line by contract — so a sentence
                    explaining why a harness offers nothing was clipped mid-word
                    and collided with the composer beneath it. It is rendered as
                    a padded paragraph instead: no row height, no hover
                    affordance and no focus stop, because there is nothing here
                    to choose.

                    `border-t` only when a group sits above it, so the state
                    where this is the WHOLE menu (pi) is a clean note rather
                    than a fragment under a stray rule.
                  */}
                  <Show
                    when={groups().harness.rows.length > 0}
                    fallback={
                      <p
                        data-slot="permission-modes-unavailable"
                        class="text-balance px-2.5 py-2 text-[12px] leading-[1.45] text-v2-text-text-faint"
                        classList={{ "mt-1 border-t border-border-base pt-2.5": groups().claxedo.length > 0 }}
                      >
                        {groups().harness.unavailable}
                      </p>
                    }
                  >
                    {/*
                      The label names WHOSE vocabulary these rows are in, which
                      is the one thing the rows themselves cannot say: they carry
                      the harness's names verbatim, so without a heading there is
                      nothing on screen tying "Accept edits" to Claude.
                    */}
                    <MenuV2.Group>
                      <MenuV2.GroupLabel>{groups().harness.label}</MenuV2.GroupLabel>
                      <For each={groups().harness.rows}>
                        {(item) => <ModeRow row={item} current={props.current} onSelect={props.onSelect} />}
                      </For>
                    </MenuV2.Group>
                  </Show>
                </>
              )}
            </Show>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
    </Show>
  )
}

/**
 * The three strings a mode row shows.
 *
 * Extracted and exported because this is exactly where the regression happened:
 * `caveat` was quietly dropped from the assembled parts while `modes.ts` kept
 * producing it and `modes.test.ts` kept asserting it existed, so the suite
 * stayed green while the warning stopped reaching anyone. As a pure function it
 * can be tested without standing up a portal-rendered menu.
 *
 * - `detail`   — what the mode does, plus why it is unavailable if it is.
 * - `caveat`   — the condition that can withdraw it. Rendered separately and
 *                never clamped: on the local-answering path this is the line
 *                that says the harness enforces nothing.
 * - `tooltip`  — everything, because `detail` is clamped to two lines and a
 *                truncated `blockedReason` is unreadable exactly when it matters.
 */
export function permissionRowText(row: PermissionModeRow) {
  const detail = [row.option.description, row.blockedReason].filter(Boolean).join(" — ")
  const caveat = row.option.caveat
  return {
    detail,
    caveat,
    tooltip: [detail, caveat].filter(Boolean).join(" — ") || row.option.name,
  }
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
  const tooltip = () => text().tooltip

  return (
    <Tooltip placement="right" value={tooltip()}>
      <MenuV2.Item
        data-permission-mode-row
        data-mode={option().id}
        data-what={option().delivery.kind}
        data-selectable={props.row.selectable ? "true" : "false"}
        /*
         * `data-checked` is the menu's own selected convention — it already
         * drives weight and accent colour in menu-v2.css. This row was styling
         * selection by tinting the leading glyph from `icon-muted` to
         * `icon-base`, which is a barely-visible grey shift on a 14px icon, so
         * every row read the same. Opting into the existing contract gives the
         * check, the weight and the colour together.
         */
        data-checked={selected() ? "true" : undefined}
        aria-checked={selected()}
        class="w-full"
        disabled={!props.row.selectable}
        onSelect={() => props.row.selectable && props.onSelect(option())}
      >
        <span class="flex w-full min-w-0 items-start gap-2">
          <Icon
            name={option().id === CLAXEDO_ASK_ALWAYS_ID ? "hand" : "shield"}
            size="small"
            /*
             * `mt-0.5` optically centres a 14px glyph against the 16px label
             * line — geometric centring sits it a touch high.
             */
            class="mt-0.5 shrink-0 transition-[color] duration-150 ease-[cubic-bezier(0.2,0,0,1)]"
            classList={{
              "text-v2-icon-icon-base": selected(),
              "text-v2-icon-icon-muted": !selected(),
            }}
          />
          <span class="flex min-w-0 flex-1 flex-col gap-0.5">
            <span data-slot="menu-v2-item-content" class="text-[13px] leading-4 text-v2-text-text-base">
              {option().name}
            </span>
            <Show when={detail()}>
              <span
                data-slot="permission-mode-description"
                class="line-clamp-2 whitespace-normal text-[11px] leading-[15px] text-v2-text-text-faint"
              >
                {detail()}
              </span>
            </Show>
            <Show when={caveat()}>
              <span
                data-slot="permission-mode-caveat"
                class="whitespace-normal text-[11px] leading-[15px]"
                // The composer is v2 UI, so this is the v2 warning foreground.
                // Not `--text-danger`: that token is not defined by the theme
                // layer these menus render under, so it silently resolves to
                // inherited body text and the caveat stops reading as a warning.
                style={{ color: "var(--v2-state-fg-warning)" }}
              >
                {caveat()}
              </span>
            </Show>
          </span>
          {/*
            Trailing rather than leading, because the leading slot already
            carries the shield/hand glyph that says what KIND of mode this is.
            Two marks on the left would compete; kind on the left and state on
            the right keeps each answering one question.

            Always mounted, never conditionally rendered: the 16px slot holds
            the row's width steady between states, and the check can animate in
            rather than appearing. Rows are multi-line, so it pins to the first
            line instead of centring against the whole block.
          */}
          <span
            data-slot="menu-v2-item-indicator"
            data-checked={selected() ? "true" : undefined}
            aria-hidden="true"
            class="mt-0.5 shrink-0"
          >
            <BareIcon name="check-small" size="small" />
          </span>
        </span>
      </MenuV2.Item>
    </Tooltip>
  )
}
