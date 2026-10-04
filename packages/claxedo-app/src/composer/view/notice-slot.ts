import { createMemo, createSignal, type Accessor } from "solid-js"

export type ComposerNoticeTone = "critical" | "warning" | "progress" | "info"

export type ComposerNotice = {
  kind: string
  tone: ComposerNoticeTone
  message: string
  detail?: string
  title?: string
  action?: { label: string; ariaLabel?: string; run: () => void }
}

export type ComposerNoticeChannel = {
  notices: Accessor<readonly ComposerNotice[]>
  publish: (source: object, notice: ComposerNotice | undefined) => void
}

const TONE_ORDER: readonly ComposerNoticeTone[] = ["critical", "warning", "progress", "info"]

export function rankedNotices(published: Iterable<ComposerNotice>): readonly ComposerNotice[] {
  const byKind = new Map<string, ComposerNotice>()
  for (const notice of published) if (!byKind.has(notice.kind)) byKind.set(notice.kind, notice)
  return [...byKind.values()].toSorted((left, right) => TONE_ORDER.indexOf(left.tone) - TONE_ORDER.indexOf(right.tone))
}

export function createComposerNoticeChannel(): ComposerNoticeChannel {
  const [published, setPublished] = createSignal<ReadonlyMap<object, ComposerNotice>>(new Map())
  const notices = createMemo(() => rankedNotices([...published().values()].toReversed()))
  const publish = (source: object, notice: ComposerNotice | undefined) =>
    setPublished((current) => {
      const next = new Map(current)
      next.delete(source)
      if (notice) next.set(source, notice)
      return next
    })
  return { notices, publish }
}
