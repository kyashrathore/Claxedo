import { useServer, type PlacementId } from "@/server"
import { DataProvider, TranscriptKitProviders, type OptimisticUserMessage } from "@/transcript"
import { resolveTranscriptTypography, transcriptTypographyStyle } from "@/ui/utils"
import { TimelineUserMessage } from "./timeline/timeline-user-message"
import { useTranscriptTypography } from "./timeline/transcript-typography"
import "./transcript-kit.css"

export function SentMessage(props: { readonly message: OptimisticUserMessage; readonly placementId: PlacementId }) {
  const server = useServer()
  const typography = useTranscriptTypography()
  return (
    <TranscriptKitProviders>
      <DataProvider directory={server.placements.byId(props.placementId)?.path ?? ""}>
        <div class="mb-4" style={transcriptTypographyStyle(resolveTranscriptTypography(typography()))}>
          <TimelineUserMessage message={props.message} parts={props.message.parts} />
        </div>
      </DataProvider>
    </TranscriptKitProviders>
  )
}
