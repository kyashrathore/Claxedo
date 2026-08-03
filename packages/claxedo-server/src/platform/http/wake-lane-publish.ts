/**
 * The PUBLISHER half of the wake lane: naming a lane and nudging it.
 *
 * The lane itself is a Durable Object and stays in the hosted-workerd
 * deployment. What is here is what a caller needs to ring it, described
 * structurally — the namespace is the two methods actually used, not
 * `DurableObjectNamespace` — so a host can hold one without importing a
 * deployment or running on Workers.
 */

export interface WakeLaneStub {
  fetch(request: Request): Promise<Response>
}

export interface WakeLaneNamespace {
  idFromName(name: string): unknown
  get(id: unknown): WakeLaneStub
}

/** DO ids need a name; the null lane gets a stable sentinel. */
export function wakeLaneName(serialKey: string | null): string {
  return serialKey === null ? " null-lane" : serialKey
}

type NudgeBody = Readonly<{ serialKey: string | null; fireAt: number }>

export async function dispatchWakeLaneNudge(namespace: WakeLaneNamespace, hint: NudgeBody) {
  const response = await namespace.get(namespace.idFromName(wakeLaneName(hint.serialKey))).fetch(
    new Request("https://wake-lane.internal/nudge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(hint),
    }),
  )
  if (!response.ok) {
    throw new Error(`Wake lane nudge failed: ${response.status} ${await response.text()}`.trim())
  }
}
