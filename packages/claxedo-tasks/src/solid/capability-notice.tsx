import type { PresetPlacement } from "../contracts"
import { CAPABILITY_GUARANTEE } from "./view-model"

/**
 * What a placement actually promises about capabilities.
 *
 * Quiet on purpose: this is the scope of a guarantee, not a warning, and a
 * banner would read as one. The wording is the low-level design's — the
 * selected-only promise covers registered optional capabilities and their
 * credentials, and says nothing about the repository, the shell or the
 * network, which follow the host's own policy.
 */
export function CapabilityNotice(props: { placement: PresetPlacement; testId?: string }) {
  return (
    <p class="tsk-notice-inline" data-testid={props.testId}>
      <span class="tsk-notice-glyph" aria-hidden="true">
        ⓘ
      </span>
      <span>{CAPABILITY_GUARANTEE[props.placement]}</span>
    </p>
  )
}
