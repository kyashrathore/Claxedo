import { Show } from "solid-js"
import { Icon, type IconProps } from "@/ui"

export function MessageDivider(props: { label: string; icon?: IconProps["name"] }) {
  return (
    <div data-component="compaction-part">
      <div data-slot="compaction-part-divider">
        <span data-slot="compaction-part-line" />
        <span data-slot="compaction-part-label" class="text-12-regular text-text-weak">
          <Show when={props.icon}>
            <span data-slot="compaction-part-icon">
              <Icon name={props.icon!} size="small" />
            </span>
          </Show>
          {props.label}
        </span>
        <span data-slot="compaction-part-line" />
      </div>
    </div>
  )
}
