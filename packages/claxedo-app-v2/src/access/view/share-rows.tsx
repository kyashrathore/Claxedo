import { For, Show } from "solid-js"
import { Button } from "@/ui"
import { useTranslator } from "@/i18n"
import type { SessionRef } from "@/server"
import { dictionary } from "../i18n"
import type { SessionShare, SessionShares, ShareRequest } from "../model"

export function ShareRows(props: {
  readonly sessionRef: SessionRef
  readonly shares: SessionShares
  readonly busy: boolean
  readonly onShare: (request: ShareRequest) => void
  readonly onRevoke: (shareId: string) => void
}) {
  const t = useTranslator(dictionary)
  const name = (share: SessionShare) =>
    share.to.kind === "org" ? t("access.share.org") : (share.to.label ?? t("access.share.user", { id: share.to.userId }))
  const levelLabel = (share: SessionShare) =>
    t(share.level === "send" ? "access.share.level.send" : "access.share.level.follow")
  const flip = (share: SessionShare) =>
    props.onShare({
      ref: props.sessionRef,
      level: share.level === "send" ? "follow" : "send",
      to: share.to,
      description: name(share),
    })
  const empty = () => props.shares.shares.length === 0 && props.shares.participants.length === 0

  return (
    <ul class="share-rows" aria-label={t("access.share.title")}>
      <Show when={empty()}>
        <li class="share-empty">{t("access.share.empty")}</li>
      </Show>
      <For each={props.shares.participants}>
        {(participant) => (
          <li class="share-row">
            <span class="share-name">{t("access.share.participant", { name: participant.label ?? participant.userId })}</span>
          </li>
        )}
      </For>
      <For each={props.shares.shares}>
        {(share) => (
          <li class="share-row" data-share={share.id} data-level={share.level}>
            <span class="share-name">{name(share)}</span>
            <span class="share-level">{levelLabel(share)}</span>
            <Button
              size="small"
              variant="ghost"
              disabled={props.busy}
              aria-label={`${share.level === "send" ? t("access.share.limit") : t("access.share.allow")}: ${name(share)}`}
              onClick={() => flip(share)}
            >
              {share.level === "send" ? t("access.share.limit") : t("access.share.allow")}
            </Button>
            <Button
              size="small"
              variant="ghost"
              disabled={props.busy}
              aria-label={t("access.share.revokeFor", { name: name(share) })}
              onClick={() => props.onRevoke(share.id)}
            >
              {t("access.share.revoke")}
            </Button>
          </li>
        )}
      </For>
    </ul>
  )
}
