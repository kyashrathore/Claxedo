import type { JSX } from "solid-js"
import { usePhone } from "@/lib/viewport"
import { useServer, type PlacementId } from "@/server"
import { usePreferences } from "@/settings"
import { DataProvider, TranscriptKitProviders, type OptimisticUserMessage } from "@/transcript"
import { resolveTranscriptTypography, transcriptTypographyStyle } from "@/ui/utils"
import { TimelineThinkingRow, useTranscriptTypography } from "./timeline"
import { TimelineUserMessage } from "./timeline/timeline-user-message"
import { timelineText } from "./timeline-host"
import { useSessionScreenText } from "./text"
import "./transcript-kit.css"

function DraftTranscriptRow(props: { readonly centered: boolean; readonly children: JSX.Element }) {
  return (
    <div
      classList={{
        "min-w-0 w-full max-w-full": true,
        "md:max-w-[var(--transcript-measure,48rem)] 2xl:max-w-[var(--transcript-measure,880px)] md:mx-auto": props.centered,
      }}
    >
      <div data-component="session-turn" class="min-w-0 w-full relative" style={{ height: "auto" }}>
        {props.children}
      </div>
    </div>
  )
}

export function DraftTranscript(props: { readonly message: OptimisticUserMessage; readonly placementId: PlacementId }) {
  const server = useServer()
  const phone = usePhone()
  const preferences = usePreferences()
  const typography = useTranscriptTypography()
  const t = timelineText(useSessionScreenText())
  return (
    <TranscriptKitProviders>
      <DataProvider directory={server.placements.byId(props.placementId)?.path ?? ""}>
        <div class="flex min-h-0 w-full flex-1 flex-col overflow-hidden" style={transcriptTypographyStyle(resolveTranscriptTypography(typography()))}>
          <div aria-hidden="true" class="flex-1" />
          <DraftTranscriptRow centered={!phone()}>
            <TimelineUserMessage message={props.message} parts={props.message.parts} />
          </DraftTranscriptRow>
          <DraftTranscriptRow centered={!phone()}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <TimelineThinkingRow t={t} showReasoningSummaries={preferences.transcript.showReasoningSummaries} />
            </div>
          </DraftTranscriptRow>
          <div aria-hidden="true" class="h-16 shrink-0" />
        </div>
      </DataProvider>
    </TranscriptKitProviders>
  )
}
