/**
 * The doorbell streams the fake control plane holds per enrollment, rung by
 * every owner-side change exactly where the real routes nudge the owner's
 * live-sync room. The wire is the bridge's: a bootstrap heartbeat first, then
 * one `host.changed` frame per ring with an `id:` of its own.
 */

type HeldStream = { write: (frame: string) => void; close: () => void }

export function createFakeMachineEventStreams(now: () => number) {
  const streams = new Map<string, Set<HeldStream>>()
  let sequence = 0
  const encoder = new TextEncoder()

  return {
    open(enrollment: { enrollment_id: string }, signal: AbortSignal | undefined) {
      const held = streams.get(enrollment.enrollment_id) ?? new Set<HeldStream>()
      streams.set(enrollment.enrollment_id, held)
      let stream: HeldStream | undefined
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          stream = {
            write: (frame) => controller.enqueue(encoder.encode(frame)),
            close: () => {
              held.delete(stream!)
              try {
                controller.close()
              } catch {
                // Already closed by the reader going away.
              }
            },
          }
          held.add(stream)
          stream.write(`id: ${sequence}\ndata: {"type":"heartbeat"}\n\n`)
          signal?.addEventListener("abort", () => stream?.close(), { once: true })
        },
        cancel() {
          if (stream) held.delete(stream)
        },
      })
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
    },
    ring(enrollment: { enrollment_id: string; host_id: string; owner: string }) {
      sequence += 1
      const frame = `id: ${sequence}\ndata: ${JSON.stringify({
        type: "host.changed",
        hostId: enrollment.host_id,
        ownerUserId: enrollment.owner,
        ts: now(),
      })}\n\n`
      for (const stream of streams.get(enrollment.enrollment_id) ?? []) stream.write(frame)
    },
    /** How many doorbell streams this enrollment holds open right now. */
    held(enrollmentId: string) {
      return streams.get(enrollmentId)?.size ?? 0
    },
    /** End every stream the enrollment holds, as a deploy or an idle proxy would, without deciding anything. */
    drop(enrollmentId: string) {
      for (const stream of streams.get(enrollmentId) ?? []) stream.close()
    },
  }
}
