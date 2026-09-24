import { createSignal } from "solid-js"
import { Button, Select, TextInput } from "@/ui"
import { useTranslator } from "@/i18n"
import type { SessionRef } from "@/server"
import { dictionary } from "../i18n"
import type { ShareLevel, ShareRequest } from "../model"

const LEVELS: readonly ShareLevel[] = ["follow", "send"]

export function ShareForm(props: {
  readonly sessionRef: SessionRef
  readonly busy: boolean
  readonly onShare: (request: ShareRequest) => void
}) {
  const t = useTranslator(dictionary)
  const [identifier, setIdentifier] = createSignal("")
  const [level, setLevel] = createSignal<ShareLevel>("follow")
  const levelLabel = (value: ShareLevel) => t(value === "send" ? "access.share.level.send" : "access.share.level.follow")

  const submit = (event: Event) => {
    event.preventDefault()
    const trimmed = identifier().trim()
    if (!trimmed || props.busy) return
    props.onShare({
      ref: props.sessionRef,
      level: level(),
      to: { kind: "identifier", identifier: trimmed },
      description: t("access.share.added"),
    })
    setIdentifier("")
  }

  return (
    <form class="share-form" onSubmit={submit} aria-label={t("access.share.add")}>
      <TextInput
        aria-label={t("access.share.identifier")}
        placeholder={t("access.share.identifier")}
        value={identifier()}
        onInput={(event) => setIdentifier(event.currentTarget.value)}
      />
      <Select
        aria-label={t("access.share.level")}
        options={[...LEVELS]}
        current={level()}
        value={(value) => value}
        label={levelLabel}
        onSelect={(value) => value && setLevel(value)}
      />
      <Button type="submit" size="small" disabled={props.busy || !identifier().trim()}>
        {t("access.share.add")}
      </Button>
    </form>
  )
}
