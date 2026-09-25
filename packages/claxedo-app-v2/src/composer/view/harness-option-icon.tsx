import { ClaxedoIcon as Icon } from "@/ui"
import { isNativeHarness, type HarnessType } from "../harness/profile"

export function HarnessOptionIcon(props: { harness?: HarnessType }) {
  if (!props.harness) return <Icon name="plus" size="small" class="shrink-0" />
  if (isNativeHarness(props.harness, "claude")) {
    return <Icon name="claude" size="small" class="shrink-0" />
  }
  if (isNativeHarness(props.harness, "codex")) {
    return <Icon name="openai" size="small" class="shrink-0" />
  }
  if (isNativeHarness(props.harness, "cursor")) {
    return <Icon name="cursor" size="small" class="shrink-0" />
  }
  return <Icon name="pi" size="small" class="shrink-0" />
}
