import { createEffect, onCleanup } from "solid-js"
import { toAppError } from "@/server"
import type { SessionList, SessionView } from "@/session"
import { displayedOutcome, outcomeTargetSelector } from "./seen-outcome"

type Candidate = NonNullable<ReturnType<typeof displayedOutcome>>

function observeOutcome(root: HTMLElement, candidate: Candidate, acknowledge: SessionList["markSeen"]): () => void {
  let target: Element | undefined
  let intersecting = false
  let pending = false
  let acknowledged = false
  const seen = async () => {
    if (!intersecting || document.visibilityState !== "visible" || pending || acknowledged) return
    pending = true
    try { await acknowledge(candidate.row); acknowledged = true }
    catch (error) { console.error("Could not acknowledge the displayed session outcome", { sessionId: candidate.row.ref.sessionId, error: toAppError(error) }) }
    finally { pending = false }
  }
  const intersection = new IntersectionObserver((entries) => {
    intersecting = entries.some((entry) => entry.target === target && entry.isIntersecting)
    void seen()
  }, { root })
  const find = () => {
    const next = root.querySelector(outcomeTargetSelector(candidate.target))
    if (target === next) return
    intersection.disconnect()
    intersecting = false
    target = next ?? undefined
    if (target) intersection.observe(target)
  }
  const mutations = new MutationObserver(find)
  mutations.observe(root, { childList: true, subtree: true })
  document.addEventListener("visibilitychange", seen)
  find()
  return () => { intersection.disconnect(); mutations.disconnect(); document.removeEventListener("visibilitychange", seen) }
}

export function acknowledgeVisibleOutcome(input: { view: () => SessionView; active: () => boolean; scroller: () => HTMLElement | undefined; acknowledge: SessionList["markSeen"] }) {
  createEffect(() => {
    const view = input.view()
    const candidate = displayedOutcome(view.row(), view.conversation()?.messages ?? [], view.conversation()?.parts ?? {})
    if (!input.active() || !candidate) return
    let stop: (() => void) | undefined
    const frame = requestAnimationFrame(() => {
      const root = input.scroller()
      if (root) stop = observeOutcome(root, candidate, input.acknowledge)
    })
    onCleanup(() => { cancelAnimationFrame(frame); stop?.() })
  })
}
