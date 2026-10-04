import type { RoutedEvent } from "../../contract"
import type { ClaudeFrame as Frame } from "./live-query"

const HELD_LIMIT = 1_000

function progressTask(frame: Frame): string | undefined {
  return frame.type === "system" && frame.subtype === "task_progress" ? frame.task_id : undefined
}

export class ClaudeHeldFrames {
  private frames: Frame[] = []
  private dropped = 0

  hold(frame: Frame): void {
    const task = progressTask(frame)
    if (task) this.frames = this.frames.filter((held) => progressTask(held) !== task)
    this.frames.push(frame)
    if (this.frames.length <= HELD_LIMIT) return
    this.frames.shift()
    this.dropped += 1
  }

  take(): { frames: Frame[]; dropped?: RoutedEvent } {
    const frames = this.frames
    const dropped = this.dropped
    this.frames = []
    this.dropped = 0
    return { frames, ...(dropped ? { dropped: heldFramesDropped(dropped) } : {}) }
  }
}

function heldFramesDropped(count: number): RoutedEvent {
  return { event: { type: "diagnostic", diagnostic: { code: "claude_sdk.held_frames_dropped", severity: "warn", source: "claude.sdk",
    message: `Claude sent more than ${HELD_LIMIT} frames between turns; the ${count} oldest were dropped` } },
  route: { kind: "parent" }, source: { dir: "in", method: "claude.held" } }
}
