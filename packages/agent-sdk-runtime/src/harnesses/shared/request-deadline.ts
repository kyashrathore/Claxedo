import { DEFAULT_RECOVERY_BUDGETS, capChildBudget } from "@claxedo/agent-runtime-contract"
import type { RequestDeadline } from "../../launch"

/**
 * A control request's own budget, never outliving the operation that asked for
 * it. Without a parent it still expires, so no caller waits forever on a
 * harness that has stopped answering.
 */
export function controlRequestDeadline(parent?: RequestDeadline): RequestDeadline {
  const now = Date.now()
  if (!parent) return { signal: new AbortController().signal, deadlineAt: now + DEFAULT_RECOVERY_BUDGETS.providerQueryMs }
  return { signal: parent.signal, deadlineAt: capChildBudget(parent.deadlineAt, DEFAULT_RECOVERY_BUDGETS.providerQueryMs, now) }
}

/**
 * A request that runs as long as the model does. A provider budget here would
 * cancel healthy work for being slow, so the only thing that ends it is the
 * harness process going away.
 *
 * It is deliberately not bound to the turn's abort: a harness whose start
 * response carries the id its own interrupt needs would lose the cancellation
 * along with the request. A deadline past 2^31-1 ms is not "no deadline"
 * either — Node truncates that timer to 1ms and fires it immediately.
 */
export function modelRequestDeadline(): RequestDeadline {
  return { signal: new AbortController().signal, deadlineAt: Date.now() + 2_147_483_647 }
}
