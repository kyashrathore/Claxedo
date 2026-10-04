import type { JSX } from "solid-js"
import { ClaxedoIconButton as IconButton, DropdownMenu } from "@/ui"

export type CommentMenuLabels = { readonly more: string; readonly edit: string; readonly remove: string }

export function CommentMenu(props: {
  readonly labels: CommentMenuLabels
  readonly onEdit: () => void
  readonly onDelete: () => void
}): JSX.Element {
  return (
    <div onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
      <DropdownMenu gutter={4} placement="bottom-end">
        <DropdownMenu.Trigger
          as={IconButton}
          icon="three-dots"
          variant="ghost"
          size="small"
          class="size-6 rounded-md"
          aria-label={props.labels.more}
        />
        <DropdownMenu.Portal>
          <DropdownMenu.Content>
            <DropdownMenu.Item onSelect={() => props.onEdit()}>
              {props.labels.edit}
            </DropdownMenu.Item>
            <DropdownMenu.Item onSelect={() => props.onDelete()}>
              {props.labels.remove}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>
    </div>
  )
}
