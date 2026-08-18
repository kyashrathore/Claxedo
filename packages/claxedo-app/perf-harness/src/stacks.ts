/**
 * The implementations this harness can measure.
 *
 * An id here is a promise that the thing behind it drives the SAME `FLOWS` and
 * emits the SAME `PerfRecord` metrics. That is what makes a port measurable
 * rather than merely describable: `solid-2` and `gpui` are not new benchmarks,
 * they are new producers of the existing ones.
 *
 * Adding one is deliberately cheap — an id and a label — because the cost that
 * matters is on the other side: supplying the metric vocabulary honestly,
 * including reporting a metric as absent when the stack has no equivalent.
 */
export const STACKS: Record<string, { id: string; label: string }> = {
  "solid-1": { id: "solid-1", label: "shipping renderer (Solid 1, web bundle)" },
  "solid-2": { id: "solid-2", label: "Solid 2 port (experiment)" },
  gpui: { id: "gpui", label: "native GPUI port (experiment)" },
}

export const DEFAULT_STACK_ID = "solid-1"

export function stackLabel(id: string) {
  return STACKS[id]?.label ?? id
}
