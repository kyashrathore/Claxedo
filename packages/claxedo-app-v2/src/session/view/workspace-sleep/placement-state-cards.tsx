import type { PlacementId } from "@/server"
import { MachineOfflineCard } from "./machine-offline-card"
import { WorkspaceSleepCard } from "./workspace-sleep-card"

export function PlacementStateCards(props: { readonly placementId: PlacementId }) {
  return (
    <>
      <WorkspaceSleepCard placementId={props.placementId} />
      <MachineOfflineCard placementId={props.placementId} />
    </>
  )
}
