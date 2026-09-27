import { untrack } from "solid-js"
import { asRecord, isRecord } from "@claxedo/helpers/guards"
import { readField, readString } from "@claxedo/helpers/readers"
import {
  parseCommentNote,
  parseImageMarkNote,
  readCommentMetadata,
  readImageMarkMetadata,
} from "@/lib/comment-note"
import type {
  AgentAssistantMessage as AssistantMessage,
  AgentContentPart as Part,
  AgentSnapshotFileDiff as SnapshotFileDiff,
} from "@claxedo/agent-runtime-contract"
import type { SessionStatus } from "@/server"
import type { TranscriptUserMessage as UserMessage } from "@/transcript"
import {
  FOLD_MINIMUM,
  assistantMessageSettled,
  cancelledAssistantMessageId,
  countFoldableGroups,
  foldedGroupKeys,
  isSubagentToolPart,
  turnFoldDecision,
  turnFoldShape,
  turnInterruption,
  turnSegments,
  type PartRef,
} from "@claxedo/agent-runtime-contract/turn-fold"
import { isTurnAdmissionConflict } from "@/server"
import {
  sessionRecoveryClass,
  sessionRecoveryDescription,
} from "./turn-recovery"
import { stripRelayPrefix } from "./provider-error-detail"
import type { TurnOutcome } from "./model"
import { TimelineRow } from "./timeline-row-model"

export type SummaryDiff = SnapshotFileDiff & { file: string }

export function uniqueSummaryDiffs(diffs: SnapshotFileDiff[] | undefined) {
  const files = new Set<string>()
  return (diffs ?? [])
    .reduceRight<SummaryDiff[]>((result, diff) => {
      if (!isSummaryDiff(diff)) return result
      if (files.has(diff.file)) return result
      files.add(diff.file)
      result.push(diff)
      return result
    }, [])
    .reverse()
}

function isSummaryDiff(value: SnapshotFileDiff): value is SummaryDiff {
  return typeof value.file === "string"
}

export namespace Timeline {
  export function coldFinalVisibleAssistantMessageIds(
    assistantMessages: AssistantMessage[],
    getMessageParts: (messageId: string) => Part[],
  ) {
    const finalAssistant = assistantMessages.at(-1)
    if (!finalAssistant) return undefined
    const visible = new Set([finalAssistant.id])
    for (const message of assistantMessages) {
      if (getMessageParts(message.id).some((part) => isSubagentToolPart(part))) {
        visible.add(message.id)
      }
    }
    return visible
  }

  export function constructMessageRows(
    userMessage: UserMessage,
    getMessageParts: (messageId: string) => Part[],
    hasText: (part: Part) => boolean,
    assistantMessages: AssistantMessage[],
    showReasoning: boolean,
    status: SessionStatus["kind"],
    isActive: boolean,
    isFoldedChoice: (userMessageId: string) => boolean | undefined = () => undefined,
    lastTurn?: TurnOutcome,
    visibleAssistantMessageIds?: ReadonlySet<string>,
    folded?: { readonly foldableCount: number },
    isPartExpanded: (partId: string) => boolean = () => false,
    settlePending = false,
    thinkingHeading?: string,
  ) {
    const rows: TimelineRow.TimelineRow[] = []

    const userParts = getMessageParts(userMessage.id)
    const comments = userParts.flatMap((p) => MessageComment.fromPart(p) ?? [])
    const compaction = userParts.some((p) => p.type === "compaction")
    const handoff = userParts.flatMap(readHandoffPart)[0]
    const lastAssistantMessage = assistantMessages[assistantMessages.length - 1]
    const shape = turnFoldShape({
      assistantMessages,
      partsOf: getMessageParts,
      hasText,
      showReasoning,
      compaction,
      cancelledAssistantMessageId: cancelledAssistantMessageId(lastTurn),
    })
    const interrupted = shape.interruptedMessageIndex !== -1
    const errorMessage = shape.errorMessage
    const error = errorMessage?.error
    const assistantPartRefs = shape.refs
    const visibleAssistantPartRefs = visibleAssistantMessageIds
      ? assistantPartRefs.filter((ref) => visibleAssistantMessageIds.has(ref.messageId))
      : assistantPartRefs
    const assistantItems = turnSegments(visibleAssistantPartRefs, shape).flatMap((segment, index) => [
      ...(index > 0 ? [{ type: "interrupted" as const }] : []),
      ...segment.map((group) => ({ type: "part" as const, group })),
    ])
    if (comments.length > 0)
      rows.push(
        TimelineRow.CommentStrip({
          userMessageId: userMessage.id,
        }),
      )

    rows.push(
      TimelineRow.UserMessage({
        userMessageId: userMessage.id,
        anchor: comments.length === 0,
      }),
    )

    if (compaction) {
      rows.push(
        TimelineRow.TurnDivider({
          userMessageId: userMessage.id,
          label: "compaction",
        }),
      )
    }
    if (handoff) {
      rows.push(
        TimelineRow.TurnDivider({
          userMessageId: userMessage.id,
          label: "handoff",
          harness: handoffHarnessLabel(handoff.to?.id),
        }),
      )
    }

    const partById = new Map(assistantPartRefs.map((ref) => [ref.part.id, ref.part] as const))
    const partOfRef = (ref: PartRef) => {
      const found = partById.get(ref.partId)
      return found ? { type: untrack(() => found.type), userOpen: isPartExpanded(ref.partId) } : found
    }
    const foldableCount = folded ? folded.foldableCount : countFoldableGroups(turnSegments(assistantPartRefs, shape).flat(), partOfRef)
    const completedTimes = assistantMessages
      .map((message) => message.time.completed)
      .filter((value): value is number => typeof value === "number")
    const interruptedActivityTime =
      interrupted && !shape.harnessInterrupted
        ? lastTurn?.completedAt
        : interrupted && lastAssistantMessage
          ? lastKnownPartActivity(getMessageParts(lastAssistantMessage.id))
          : undefined
    const endTimes =
      interruptedActivityTime !== undefined ? [...completedTimes, interruptedActivityTime] : completedTimes
    const createdTime = userMessage.time?.created
    const durationMs =
      endTimes.length && typeof createdTime === "number"
        ? Math.max(0, Math.max(...endTimes) - createdTime)
        : undefined
    const partsPending = folded !== undefined
    const working = isActive && (status === "working" || status === "retrying" || settlePending)
    const fold = turnFoldDecision({
      foldableCount,
      settled: shape.settled,
      interrupted,
      errored: !!error,
      busy: working,
      partsPending,
      userChoice: isFoldedChoice(userMessage.id),
    })
    if (partsPending && !fold.folded && !working) {
      rows.push(TimelineRow.TurnLoading({ userMessageId: userMessage.id }))
      return rows
    }
    const turnTokens = assistantMessages.reduce((sum, message) => {
      const t = message.tokens
      if (!t) return sum
      return sum + (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
    }, 0)
    const turnCost = assistantMessages.reduce((sum, message) => sum + (message.cost ?? 0), 0)

    const foldedKeys = foldedGroupKeys(
      fold,
      assistantItems.flatMap((item) => (item.type === "part" ? [item.group] : [])),
      partOfRef,
    )
    const emittedCount = assistantItems.filter(
      (item) => item.type === "part" && !foldedKeys.has(item.group.key),
    ).length

    if (fold.canFold) {
      rows.push(
        TimelineRow.TurnFold({
          userMessageId: userMessage.id,
          durationMs,
          foldCount: Math.max(foldableCount, FOLD_MINIMUM),
          folded: fold.folded,
          tokens: turnTokens,
          cost: turnCost,
        }),
      )
    }

    let assistantGroupIndex = 0
    assistantItems.forEach((item) => {
      if (item.type === "interrupted") {
        rows.push(
          TimelineRow.TurnDivider({
            userMessageId: userMessage.id,
            label: "interrupted",
            ...(typeof durationMs === "number" ? { durationMs } : {}),
          }),
        )
        return
      }

      if (foldedKeys.has(item.group.key)) return

      rows.push(
        TimelineRow.AssistantPart({
          userMessageId: userMessage.id,
          group: item.group,
          previousAssistantPart: assistantGroupIndex > 0,
          lastAssistantPart: assistantGroupIndex === emittedCount - 1,
        }),
      )
      assistantGroupIndex += 1
    })

    const trailingGroup = assistantItems.findLast((item) => item.type === "part")?.group
    const trailingRef = trailingGroup?.type === "part" ? trailingGroup.ref : trailingGroup?.refs.at(-1)
    const trailingPart = trailingRef ? partById.get(trailingRef.partId) : undefined
    const trailingGroupIsLive =
      !!trailingGroup &&
      trailingRef?.messageId === lastAssistantMessage?.id &&
      (trailingGroup.type !== "part" || trailingPart?.type === "tool" || trailingPart?.type === "reasoning")
    const newestOpen = !lastAssistantMessage || !assistantMessageSettled(lastAssistantMessage)
    if (isActive && (status === "working" || settlePending) && newestOpen && !error && !trailingGroupIsLive) {
      rows.push(
        TimelineRow.Thinking({
          userMessageId: userMessage.id,
          reasoningHeading: thinkingHeading,
        }),
      )
    }

    if (isActive && status === "retrying") rows.push(TimelineRow.Retry({ userMessageId: userMessage.id }))

    const diffs = uniqueSummaryDiffs(userMessage.summary?.diffs)
    if (diffs.length > 0 && (status === "idle" || !isActive)) {
      rows.push(
        TimelineRow.DiffSummary({
          userMessageId: userMessage.id,
          diffs,
        }),
      )
    }

    if (error && !interrupted) {
      const data = error.data?.message
      const raw = typeof data === "string" ? data : data === undefined || data === null ? "" : String(data)
      const message = unwrapErrorMessage(stripRelayPrefix(raw).message)
      const rawBody = readField(error.data, "responseBody")
      const body = typeof rawBody === "string" ? rawBody.trim() : ""
      const turnAdmissionConflict = isTurnAdmissionConflict(error)
      const recoveryClass = sessionRecoveryClass(error)
      rows.push(
        TimelineRow.Error({
          userMessageId: userMessage.id,
          text: body && body !== message ? `${message}\n${body}` : message,
          recoveryClass: turnAdmissionConflict ? undefined : recoveryClass,
          summary: turnAdmissionConflict
            ? "The previous message was still finishing. Try again."
            : sessionRecoveryDescription(recoveryClass, error, {
                providerID: errorMessage?.providerID,
                modelID: errorMessage?.modelID,
              }),
          presentation: turnAdmissionConflict ? "turn-conflict" : undefined,
          error,
          providerID: errorMessage?.providerID,
          modelID: errorMessage?.modelID,
        }),
      )
    }

    return rows
  }

  export function reasoningHeadingOf(parts: readonly Part[]): string | undefined {
    return parts
      .map((part) => (part.type === "reasoning" && part.text ? reasoningHeading(part.text) : undefined))
      .find((value): value is string => !!value)
  }

  function reasoningHeading(text: string) {
    const markdown = text.replace(/\r\n?/g, "\n")
    const html = markdown.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i)
    if (html?.[1]) {
      const value = cleanHeading(html[1].replace(/<[^>]+>/g, " "))
      if (value) return value
    }

    const atx = markdown.match(/^\s{0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/m)
    if (atx?.[1]) {
      const value = cleanHeading(atx[1])
      if (value) return value
    }

    const setext = markdown.match(/^([^\n]+)\n(?:=+|-+)\s*$/m)
    if (setext?.[1]) {
      const value = cleanHeading(setext[1])
      if (value) return value
    }

    const strong = markdown.match(/^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*$/m)
    if (strong?.[1]) {
      const value = cleanHeading(strong[1])
      if (value) return value
    }
    return undefined
  }

  function cleanHeading(value: string) {
    return value
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[*_~]+/g, "")
      .trim()
  }

  function unwrapErrorMessage(message: string) {
    const text = message.replace(/^Error:\s*/, "").trim()

    const parse = (value: string) => {
      if (!/^\s*[[{]/.test(value)) return undefined
      try {
        return JSON.parse(value) as unknown
      } catch (error) {
        console.warn("An error message that looks like JSON could not be parsed", { error })
        return undefined
      }
    }

    const read = (value: string) => {
      const first = parse(value)
      if (typeof first !== "string") return first
      return parse(first.trim())
    }

    let json = read(text)

    if (json === undefined) {
      const start = text.indexOf("{")
      const end = text.lastIndexOf("}")
      if (start !== -1 && end > start) json = read(text.slice(start, end + 1))
    }

    if (!isRecord(json)) return message

    const err = asRecord(json.error)
    if (err) {
      const type = readString(err, "type")
      const msg = readString(err, "message")
      if (type && msg) return `${type}: ${msg}`
      if (msg) return msg
      if (type) return type
      const code = readString(err, "code")
      if (code) return code
    }

    const msg = readString(json, "message")
    if (msg) return msg

    const reason = readString(json, "error")
    if (reason) return reason

    return message
  }

  export function turnDurationMs(
    userMessage: { time: { created: number } },
    assistantMessages: AssistantMessage[],
  ) {
    const end = assistantMessages.reduce<number | undefined>((max, item) => {
      const completed = item.time.completed
      if (typeof completed !== "number") return max
      if (max === undefined) return completed
      return Math.max(max, completed)
    }, undefined)
    if (typeof end !== "number") return undefined
    if (end < userMessage.time.created) return undefined
    return end - userMessage.time.created
  }

  export function turnInterrupted(
    assistantMessages: AssistantMessage[],
    lastTurn?: TurnOutcome,
  ) {
    return turnInterruption(assistantMessages, cancelledAssistantMessageId(lastTurn)).index !== -1
  }
}

function handoffHarnessLabel(id?: string) {
  if (!id) return "another harness"
  if (id === "opencode") return "OpenCode"
  if (id === "pi") return "Pi"
  return `${id[0]?.toUpperCase() ?? ""}${id.slice(1)}`
}

function readHandoffPart(part: Part): Array<{ to?: { id?: string; access?: string } }> {
  if ((part.type as string) !== "handoff" || !("to" in part) || !part.to || typeof part.to !== "object") return []
  const to = part.to as Record<string, unknown>
  return [{
    to: {
      ...(typeof to.id === "string" ? { id: to.id } : {}),
      ...(typeof to.access === "string" ? { access: to.access } : {}),
    },
  }]
}

function lastKnownPartActivity(parts: Part[]): number | undefined {
  const times = parts.flatMap((part): number[] => {
    if (part.type === "text" || part.type === "reasoning") {
      return [part.time?.end, part.time?.start].filter((value): value is number => typeof value === "number")
    }
    if (part.type === "tool") {
      const state = part.state
      if (state.status === "completed" || state.status === "error") return [state.time.end]
      if (state.status === "running") return [state.time.start]
    }
    return []
  })
  return times.length ? Math.max(...times) : undefined
}

export namespace MessageComment {
  export type FileComment = {
    kind: "file"
    path: string
    comment: string
    selection?: {
      startLine: number
      endLine: number
    }
  }

  export type ImageMarkComment = {
    kind: "image-mark"
    filename: string
    number: number
    comment: string
  }

  export type MessageComment = FileComment | ImageMarkComment

  export const asFile = (comment: MessageComment) => (comment.kind === "file" ? comment : undefined)
  export const asImageMark = (comment: MessageComment) => (comment.kind === "image-mark" ? comment : undefined)

  export const fromPart = (part: Part): MessageComment | undefined => {
    if (part.type !== "text" || !part.synthetic) return undefined
    const mark = readImageMarkMetadata(part.metadata) ?? parseImageMarkNote(part.text)
    if (mark) return { kind: "image-mark", ...mark }
    const next = readCommentMetadata(part.metadata) ?? parseCommentNote(part.text)
    if (!next) return undefined
    return {
      kind: "file",
      path: next.path,
      comment: next.comment,
      selection: next.selection
        ? {
            startLine: next.selection.startLine,
            endLine: next.selection.endLine,
          }
        : undefined,
    }
  }
}
