import type { JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { IconButton, Menu } from "@/ui"
import { dictionary } from "../i18n"

export function CommentMenu(props: { readonly onEdit: () => void; readonly onDelete: () => void }): JSX.Element {
  const t = useTranslator(dictionary)
  return (
    <div onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
      <Menu placement="bottom-end">
        <Menu.Trigger as={IconButton} icon="three-dots" variant="ghost" size="small" aria-label={t("review.comment.more")} />
        <Menu.Portal>
          <Menu.Content>
            <Menu.Item onSelect={() => props.onEdit()}>{t("review.comment.edit")}</Menu.Item>
            <Menu.Item onSelect={() => props.onDelete()}>{t("review.comment.remove")}</Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu>
    </div>
  )
}
