import type { JSX } from "solid-js"
import { IconButton, Menu } from "@/ui"

export type CommentMenuLabels = { readonly more: string; readonly edit: string; readonly remove: string }

export function CommentMenu(props: {
  readonly labels: CommentMenuLabels
  readonly onEdit: () => void
  readonly onDelete: () => void
}): JSX.Element {
  return (
    <div onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
      <Menu placement="bottom-end">
        <Menu.Trigger as={IconButton} icon="three-dots" variant="ghost" size="small" aria-label={props.labels.more} />
        <Menu.Portal>
          <Menu.Content>
            <Menu.Item onSelect={() => props.onEdit()}>{props.labels.edit}</Menu.Item>
            <Menu.Item onSelect={() => props.onDelete()}>{props.labels.remove}</Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu>
    </div>
  )
}
