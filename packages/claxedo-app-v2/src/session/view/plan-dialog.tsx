import { Markdown } from "@/transcript"
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@/ui"
import type { TimelineFocus } from "./timeline"
import { TranscriptKitProviders } from "./transcript-kit"

export type PlanFocus = Extract<TimelineFocus, { kind: "plan" }>

export function PlanDialog(props: { readonly plan: PlanFocus; readonly fallbackTitle: string }) {
  return (
    <Dialog size="large">
      <DialogHeader>
        <DialogTitle>{props.plan.title ?? props.fallbackTitle}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <TranscriptKitProviders>
          <Markdown text={props.plan.markdown} cacheKey={`plan:${props.plan.sessionId}:${props.plan.planId}`} />
        </TranscriptKitProviders>
      </DialogBody>
    </Dialog>
  )
}
