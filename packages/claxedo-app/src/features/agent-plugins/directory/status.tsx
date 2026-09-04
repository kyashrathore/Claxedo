import type { PluginStatus } from "./view"

/**
 * The trailing status line a card and the detail pane agree on.
 *
 * A dot plus muted text, the same shape Settings › Connections uses for a
 * connection's health. A normal state stays muted on purpose: "installed" is
 * the expected outcome and must not compete with the plugin's name; only the
 * states that want the user's hand take a colour.
 */
export function PluginStatusLine(props: { status: PluginStatus }) {
  return (
    <span data-component="agent-plugin-status" data-tone={props.status.tone} class="inline-flex items-center gap-1.5">
      <span
        class="size-1.5 shrink-0 rounded-full"
        classList={{
          "bg-surface-success-strong": props.status.tone === "normal",
          "bg-surface-warning-strong": props.status.tone === "warning",
          "bg-surface-critical-strong": props.status.tone === "critical",
          "bg-surface-interactive-base": props.status.tone === "accent",
        }}
      />
      <span
        class="truncate text-12-regular"
        classList={{
          "text-text-weak": props.status.tone === "normal",
          "text-icon-warning-base": props.status.tone === "warning",
          "text-icon-critical-base": props.status.tone === "critical",
          "text-text-interactive-base": props.status.tone === "accent",
        }}
      >
        {props.status.label}
      </span>
    </span>
  )
}
