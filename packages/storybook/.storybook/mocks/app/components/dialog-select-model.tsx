export function ModelSelectorPopover(props: { triggerAs: any; triggerProps?: Record<string, unknown>; children: any }) {
  const Trigger = props.triggerAs
  return <Trigger {...(props.triggerProps ?? {})}>{props.children}</Trigger>
}

export const ModelSelectorPopoverV2 = ModelSelectorPopover
