import { asRecord, isRecord, readField, readString } from "@/lib/record"
import { parseCommentNote, readCommentMetadata } from "@/features/session/data/comment-note"
import type {
  AgentAssistantMessage as AssistantMessage,
  AgentContentPart as Part,
  AgentRuntimeStatus as SessionStatus,
  AgentSnapshotFileDiff as SnapshotFileDiff,
} from "@claxedo/agent-runtime-contract"
// The row builder reads a user message's `id`, `time` and optional `summary`,
// all of which the optimistic stub carries, so it takes the projected row and
// the just-typed turn renders before the runtime echoes it back.
import type { ProjectedUserMessage as UserMessage } from "../conversation/agent-conversation-codec"
import {
  FOLD_MINIMUM,
  assistantMessageSettled,
  countFoldableGroups,
  foldedGroupKeys,
  groupParts,
  isHiddenTool,
  isPendingQuestion,
  isSubagentToolPart,
  turnFoldDecision,
  type PartRef,
} from "@/ui/session-kit"
import {
  isTurnAdmissionConflict,
  sessionRecoveryClass,
  sessionRecoveryDescription,
} from "../onboarding/first-turn-recovery"
import { stripRelayPrefix } from "../onboarding/provider-error-detail"
import type { SessionTurnOutcome } from "../data/session-types"
import { TimelineRow } from "./timeline-row-model"

export type SummaryDiff = SnapshotFileDiff & { file: string }

// Keeps the last diff per file in display order. Set-based so large
// summaries stay linear instead of scanning the result per diff.
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
  export function coldFinalVisibleAssistantMessageIDs(
    assistantMessages: AssistantMessage[],
    getMessageParts: (messageID: string) => Part[],
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

  /**
   * How many of a turn's groups the fold would hide, over whatever messages the
   * caller holds. Unsegmented, so an interrupted turn — whose rows either side
   * of the interruption cannot share a group — counts one lower here than the
   * turn renders; and reasoning parts count as the default hides them, where
   * showing them splits a run into more groups. Both make this a floor, which
   * is the safe direction for a caller deciding whether a fold exists at all.
   */
  export function turnFoldableGroupCount(input: {
    assistantMessages: AssistantMessage[]
    getMessageParts: (messageID: string) => Part[]
    showReasoning?: boolean
  }) {
    const refs = input.assistantMessages.flatMap((message, messageIndex) =>
      input.getMessageParts(message.id)
        .filter((part) => renderablePart(part, input.showReasoning ?? false))
        .map((part) => ({ messageID: message.id, messageIndex, part })),
    )
    const partByID = new Map(refs.map((ref) => [ref.part.id, ref.part] as const))
    return countFoldableGroups(groupParts(refs), (ref) => partByID.get(ref.partID))
  }

  export function constructMessageRows(
    userMessage: UserMessage,
    getMessageParts: (messageID: string) => Part[],
    assistantMessages: AssistantMessage[],
    index: number,
    showReasoning: boolean,
    status: SessionStatus["type"],
    isActive: boolean,
    firstTurnRecovery = index === 0,
    isFoldedChoice: (userMessageID: string) => boolean | undefined = () => undefined,
    lastTurn?: SessionTurnOutcome,
    visibleAssistantMessageIDs?: ReadonlySet<string>,
    priorFoldableCount: (userMessageID: string) => number | undefined = () => undefined,
    isPartExpanded: (partID: string) => boolean = () => false,
    // `session.idle` lands before the final transcript read does; while the
    // post-acceptance reconciliation still owns that read the turn is working
    // even though the session status already says idle.
    settlePending = false,
    partsFragment: (messageID: string) => boolean = () => false,
  ) {
    const rows: TimelineRow.TimelineRow[] = []

    const previousUserMessage = index > 0
    const userParts = getMessageParts(userMessage.id)
    const comments = userParts.flatMap((p) => MessageComment.fromPart(p) ?? [])
    const compaction = userParts.some((p) => p.type === "compaction")
    const handoff = userParts.flatMap(readHandoffPart)[0]
    const lastAssistantMessage = assistantMessages[assistantMessages.length - 1]
    // OpenCode-native aborts are durable on the message itself. SDK-runtime aborts are
    // durable on the Session turn outcome, which must match the exact assistant message.
    // Missing completion metadata is not an abort signal: normal turns can be observed
    // between the idle event and their message completion checkpoint.
    const nativeInterruptedIndex = assistantMessages.findIndex(assistantMessageInterrupted)
    const sdkInterruptedIndex =
      nativeInterruptedIndex === -1 && lastTurn?.status === "cancelled" && lastTurn.assistantMessageId
        ? assistantMessages.findIndex((message) => message.id === lastTurn.assistantMessageId)
        : -1
    const interruptedMessageIndex =
      nativeInterruptedIndex !== -1 ? nativeInterruptedIndex : sdkInterruptedIndex
    const interrupted = interruptedMessageIndex !== -1
    // Keep the message, not just its error: its providerID/modelID are what the
    // turn actually dispatched with, and the error card names that provider.
    const errorMessage = assistantMessages.find((m) => m.error && m.error.name !== "MessageAbortedError")
    const error = errorMessage?.error
    const settled = assistantMessages.some(assistantMessageSettled)
    const assistantPartRefs = assistantMessages.flatMap((message, messageIndex) =>
      getMessageParts(message.id)
        .filter((part) =>
          renderablePart(part, showReasoning) &&
          !(interrupted && part.type === "tool" && (part.state.status === "pending" || part.state.status === "running"))
        )
        .map((part) => ({ messageID: message.id, messageIndex, part })),
    )
    // Turn semantics always come from every canonical assistant sibling. The
    // optional visibility set only bounds part rows constructed for the first
    // cold frame; error/interruption/settlement/fold/tokens/cost below continue
    // to use the complete message and part set.
    const visibleAssistantPartRefs = visibleAssistantMessageIDs
      ? assistantPartRefs.filter((ref) => visibleAssistantMessageIDs.has(ref.messageID))
      : assistantPartRefs
    // A run of tools cannot span the interruption row: grouping the refs whole merges the
    // runs either side into one group, which the fold counts as one where the turn draws two.
    const groupSegments = (refs: typeof assistantPartRefs) =>
      interrupted && !compaction
        ? [
            groupParts(refs.filter((ref) => ref.messageIndex <= interruptedMessageIndex)),
            groupParts(refs.filter((ref) => ref.messageIndex > interruptedMessageIndex)),
          ]
        : [groupParts(refs)]
    const assistantItems = groupSegments(visibleAssistantPartRefs).flatMap((segment, index) => [
      ...(index > 0 ? [{ type: "interrupted" as const }] : []),
      ...segment.map((group) => ({ type: "part" as const, group })),
    ])
    if (previousUserMessage) rows.push(TimelineRow.TurnGap({ userMessageID: userMessage.id }))

    if (comments.length > 0)
      rows.push(
        TimelineRow.CommentStrip({
          userMessageID: userMessage.id,
        }),
      )

    rows.push(
      TimelineRow.UserMessage({
        userMessageID: userMessage.id,
        anchor: comments.length === 0,
      }),
    )

    if (compaction) {
      rows.push(
        TimelineRow.TurnDivider({
          userMessageID: userMessage.id,
          label: "compaction",
        }),
      )
    }
    if (handoff) {
      rows.push(
        TimelineRow.TurnDivider({
          userMessageID: userMessage.id,
          label: "handoff",
          harness: handoffHarnessLabel(handoff.to?.id),
        }),
      )
    }

    const partByID = new Map(assistantPartRefs.map((ref) => [ref.part.id, ref.part] as const))
    const partOfRef = (ref: PartRef) => {
      const found = partByID.get(ref.partID)
      return found ? { ...found, userOpen: isPartExpanded(ref.partID) } : found
    }
    const liveFoldableCount = countFoldableGroups(groupSegments(assistantPartRefs).flat(), partOfRef)
    // A switched-to session is seeded with two messages — the turn's owning user
    // message and its tail assistant message — and the messages holding the rest
    // of its groups arrive 900ms later. Counting only what is here folds the turn
    // on that later pass, taking away rows the reader has already been given, so
    // a count the caller already knows for this turn stands until they arrive.
    const foldableCount = Math.max(liveFoldableCount, priorFoldableCount(userMessage.id) ?? 0)
    const completedTimes = assistantMessages
      .map((message) => message.time.completed)
      .filter((value): value is number => typeof value === "number")
    // SDK cancellation carries the canonical completion timestamp. Native aborts may not,
    // so fall back to the latest activity recorded on the interrupted message's parts.
    const interruptedActivityTime =
      sdkInterruptedIndex !== -1
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
    const fold = turnFoldDecision({
      foldableCount,
      settled,
      interrupted,
      errored: !!error,
      busy: isActive && (status === "busy" || status === "retry" || settlePending),
      partsPending: assistantMessages.some((message) => partsFragment(message.id)),
      userChoice: isFoldedChoice(userMessage.id),
    })
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

    // The fold row is the turn's header: it sits above the turn's content, not
    // wherever the first tool landed. A fold decided on pending parts records
    // the minimum as its count: the caller hands that back as `priorFoldableCount`
    // on the next build, so a full read that finds less to hide than the fold
    // promised does not take the row away under the reader.
    if (fold.canFold) {
      rows.push(
        TimelineRow.TurnFold({
          userMessageID: userMessage.id,
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
            userMessageID: userMessage.id,
            label: "interrupted",
            ...(typeof durationMs === "number" ? { durationMs } : {}),
          }),
        )
        return
      }

      if (foldedKeys.has(item.group.key)) return

      rows.push(
        TimelineRow.AssistantPart({
          userMessageID: userMessage.id,
          group: item.group,
          previousAssistantPart: assistantGroupIndex > 0,
          lastAssistantPart: assistantGroupIndex === emittedCount - 1,
        }),
      )
      assistantGroupIndex += 1
    })

    // The turn's trailing group is its live row while a tool runs or a thought
    // streams: the work-group header reads "Running <command>" and the reasoning
    // row shimmers on its own. The Thinking row fills every other stretch of a
    // working turn — before the first part, and between one group and the next —
    // so the live row flips between "Running …" and "Thinking" rather than
    // stacking both. Only the newest message says whether the turn is still
    // open, and only its groups can be live: a step-per-message harness
    // completes each earlier step as it goes, and a busy status gone stale must
    // not hang the row under a completed answer.
    const trailingGroup = assistantItems.findLast((item) => item.type === "part")?.group
    const trailingRef = trailingGroup?.type === "part" ? trailingGroup.ref : trailingGroup?.refs.at(-1)
    const trailingPart = trailingRef ? partByID.get(trailingRef.partID) : undefined
    const trailingGroupIsLive =
      !!trailingGroup &&
      trailingRef?.messageID === lastAssistantMessage?.id &&
      (trailingGroup.type !== "part" || trailingPart?.type === "tool" || trailingPart?.type === "reasoning")
    const newestOpen = !lastAssistantMessage || !assistantMessageSettled(lastAssistantMessage)
    if (isActive && (status === "busy" || settlePending) && newestOpen && !error && !trailingGroupIsLive) {
      const heading = assistantMessages
        .flatMap((message) => getMessageParts(message.id))
        .map((part) => (part.type === "reasoning" && part.text ? reasoningHeading(part.text) : undefined))
        .find((value): value is string => !!value)

      rows.push(
        TimelineRow.Thinking({
          userMessageID: userMessage.id,
          reasoningHeading: heading,
        }),
      )
    }

    if (isActive && status === "retry") rows.push(TimelineRow.Retry({ userMessageID: userMessage.id }))

    const diffs = uniqueSummaryDiffs(userMessage.summary?.diffs)
    if (diffs.length > 0 && (status === "idle" || !isActive)) {
      rows.push(
        TimelineRow.DiffSummary({
          userMessageID: userMessage.id,
          diffs,
        }),
      )
    }

    if (error && !interrupted) {
      const data = error.data?.message
      const raw = typeof data === "string" ? data : data === undefined || data === null ? "" : String(data)
      // Upstream relays prefix the provider's message with their own
      // "Error from provider (<their account label>): ". That label describes
      // the relay's upstream account, not the provider we dispatched to, so it
      // reads as a mislabelled provider. Drop it here; the card's summary names
      // the real provider instead.
      const message = unwrapErrorMessage(stripRelayPrefix(raw).message)
      // The provider's response body carries the machine-readable code the
      // message often omits (auth error vs capacity vs rate limit). It rides in
      // the collapsed detail, never in the summary sentence.
      // `responseBody` is present on only some members of the wire error union,
      // so read it structurally rather than narrowing by name.
      const rawBody = readField(error.data, "responseBody")
      const body = typeof rawBody === "string" ? rawBody.trim() : ""
      const turnAdmissionConflict = isTurnAdmissionConflict(error)
      const recoveryClass = sessionRecoveryClass(error)
      rows.push(
        TimelineRow.Error({
          userMessageID: userMessage.id,
          text: body && body !== message ? `${message}\n${body}` : message,
          // Attach the recovery class on every turn, not just index 0. The class is
          // position-independent (regex/wire-stamped), the renderer mounts the card
          // purely on its presence, and retry is registered on every submit. The
          // firstTurnRecovery param survives for telemetry gating.
          recoveryClass: turnAdmissionConflict ? undefined : recoveryClass,
          // Composed here, not at mount: the row already carries the human
          // sentence, so the primary line never paints raw provider bytes
          // first and get replaced a beat later.
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
      try {
        return JSON.parse(value) as unknown
      } catch {
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

  // The turn's start is the only thing read off the user message, so that is all
  // the parameter asks for: a projected row that never reached the runtime still
  // has a creation stamp, and a turn it opened still has a measurable duration.
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
    lastTurn?: SessionTurnOutcome,
  ) {
    if (assistantMessages.some(assistantMessageInterrupted)) return true
    if (lastTurn?.status !== "cancelled" || !lastTurn.assistantMessageId) return false
    return assistantMessages.some((message) => message.id === lastTurn.assistantMessageId)
  }

  function assistantMessageInterrupted(message: AssistantMessage) {
    if (message.error?.name === "MessageAbortedError") return true
    if (message.error?.name !== "UnknownError") return false
    return (message.error.data as { message?: unknown } | undefined)?.message === "Codex turn aborted"
  }
}

// Mirrors PART_MAPPING's registered part types (message-part.tsx): non-text/reasoning/
// tool parts render only when a dedicated component exists. "file" carries assistant
// image/audio/resource-link attachments to FilePartDisplay.
const renderableParts = new Set(["compaction", "handoff", "text", "reasoning", "tool", "file"])

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

// Best-effort stop timestamp for native aborts whose message has no completed time.
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

function renderablePart(part: Part, showReasoning = true) {
  if (part.type === "tool") {
    if (isHiddenTool(part)) return false
    return !isPendingQuestion(part)
  }
  if (part.type === "text") return !!part.text?.trim()
  if (part.type === "reasoning") return showReasoning && !!part.text?.trim()
  return renderableParts.has(part.type)
}

export namespace MessageComment {
  export type MessageComment = {
    path: string
    comment: string
    selection?: {
      startLine: number
      endLine: number
    }
  }

  export const fromPart = (part: Part): MessageComment | undefined => {
    if (part.type !== "text" || !part.synthetic) return undefined
    const next = readCommentMetadata(part.metadata) ?? parseCommentNote(part.text)
    if (!next) return undefined
    return {
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
