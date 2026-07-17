import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { firstTurnRecovery, type FirstTurnRecoveryClass } from "./first-turn-recovery"

export function FirstTurnRecoveryCard(props: {
  kind: FirstTurnRecoveryClass
  detail?: string
  onAction: (kind: FirstTurnRecoveryClass) => void
}) {
  const recovery = () => firstTurnRecovery(props.kind)
  return (
    <div class="rounded-lg border border-border-warning-base bg-surface-warning-base px-4 py-3" data-testid="first-turn-recovery-card" data-recovery-class={props.kind}>
      <div class="flex items-start gap-3">
        <Icon name="warning" class="mt-0.5 size-4 shrink-0 text-icon-warning-base" />
        <div class="min-w-0 flex-1">
          <div class="text-14-medium text-text-strong">{recovery().title}</div>
          <div class="mt-1 text-13-regular text-text-base">{recovery().description}</div>
          <div class="mt-1 truncate text-12-regular text-text-weak">{props.detail}</div>
          <Button class="mt-3" size="small" variant="secondary" onClick={() => props.onAction(props.kind)}>
            {recovery().label}
          </Button>
        </div>
      </div>
    </div>
  )
}
