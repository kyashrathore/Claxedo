import { A } from "@solidjs/router"
import { Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import type { SessionRowView } from "@/session"
import { sessionPath } from "@/shell"
import { dictionary } from "../i18n"
import { railStatus } from "../model"

export const SESSION_ROW_HEIGHT = 36

export function SessionRow(props: { readonly row: SessionRowView; readonly active: boolean; readonly top: number }): JSX.Element {
  const t = useTranslator(dictionary)
  const status = () => railStatus(props.row)
  return (
    <li class="rail-row-slot" style={{ transform: `translateY(${props.top}px)`, height: `${SESSION_ROW_HEIGHT}px` }}>
      <A
        href={sessionPath(props.row.ref)}
        class="rail-row"
        aria-current={props.active ? "page" : undefined}
        data-session-id={props.row.ref.sessionId}
        data-status={status()}
      >
        <span class="rail-row-status" data-status={status()} role="img" aria-label={t(`rail.status.${status()}`)} />
        <span class="rail-row-title">{props.row.title}</span>
        <Show when={props.row.archivedAt !== undefined}>
          <span class="rail-row-badge">{t("rail.archived")}</span>
        </Show>
      </A>
    </li>
  )
}
