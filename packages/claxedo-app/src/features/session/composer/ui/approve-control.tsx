import { Show, type Accessor, type JSX } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"

/**
 * Auto-accept, surfaced inside the composer instead of only as a `mod+shift+a`
 * command.
 *
 * `enabled` is the transport's `permissions` capability — the same gate the
 * `permissions.autoaccept` command uses. Every shipped harness reports `true`
 * for it, so in practice this only hides the control while a harness is still
 * polling for readiness, where the capability set is a placeholder.
 */
export function PromptApproveControl(props: {
  enabled: Accessor<boolean>
  active: Accessor<boolean>
  disabled: Accessor<boolean>
  style: Accessor<JSX.CSSProperties>
  label: string
  onToggle: VoidFunction
}) {
  return (
    <Show when={props.enabled()}>
      <Tooltip
        placement="top"
        value={props.active() ? "Approving tool calls automatically" : "Approve each tool call manually"}
      >
        <button
          data-action="prompt-approve"
          type="button"
          role="switch"
          aria-checked={props.active()}
          aria-label={props.label}
          disabled={props.disabled()}
          tabIndex={props.disabled() ? -1 : undefined}
          style={props.style()}
          onClick={props.onToggle}
          class="flex h-7 min-w-0 shrink items-center gap-1.5 rounded-md px-2.5 text-[13px] font-[440] leading-4 transition-colors duration-150 hover:bg-v2-overlay-simple-overlay-hover disabled:pointer-events-none disabled:opacity-50"
          classList={{
            "text-v2-text-text-base": props.active(),
            "text-v2-text-text-faint hover:text-v2-text-text-muted": !props.active(),
          }}
        >
          <Icon
            name="shield"
            size="small"
            class="shrink-0"
            classList={{
              "text-v2-icon-icon-accent": props.active(),
              "text-v2-icon-icon-muted": !props.active(),
            }}
          />
          <span class="truncate max-md:hidden">{props.label}</span>
        </button>
      </Tooltip>
    </Show>
  )
}
