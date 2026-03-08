import type { EventEnvelope } from "../../events";
import { runReducer, type RunState } from "./run";
import { teamReducer, type TeamState } from "./team";
import { nodeReducer, type NodeState } from "./node";
import { edgeReducer, type EdgeState } from "./edge";
import { messageReducer, type MessageState } from "./message";
import { handoffReducer, type HandoffState } from "./handoff";
import { artifactReducer, type ArtifactState } from "./artifact";
import { decisionReducer, type DecisionState } from "./decision";
import { planningReducer, type PlanningState } from "./planning";
import { leadReducer, type LeadState } from "./lead";
import { syncReducer, type SyncReducerState } from "./sync-reducer";

export interface RootState {
  run: RunState;
  team: TeamState;
  node: NodeState;
  edge: EdgeState;
  message: MessageState;
  handoff: HandoffState;
  artifact: ArtifactState;
  decision: DecisionState;
  planning: PlanningState;
  lead: LeadState;
  sync: SyncReducerState;
}

export const initialRootState: RootState = {
  run: { runs: {} },
  team: { teams: {} },
  node: { nodes: {} },
  edge: { edges: [] },
  message: { messages: [] },
  handoff: { handoffs: {} },
  artifact: { artifacts: {} },
  decision: { decisions: {} },
  planning: { plans: {} },
  lead: { leadPlans: {} },
  sync: { pushes: [], pulls: [], conflicts: [], snapshots: [], repairs: [] },
};

export const rootReducer = (state: RootState, event: EventEnvelope): RootState => {
  const newRun = runReducer(state.run, event);
  const newTeam = teamReducer(state.team, event);
  const newNode = nodeReducer(state.node, event);
  const newEdge = edgeReducer(state.edge, event);
  const newMessage = messageReducer(state.message, event);
  const newHandoff = handoffReducer(state.handoff, event);
  const newArtifact = artifactReducer(state.artifact, event);
  const newDecision = decisionReducer(state.decision, event);
  const newPlanning = planningReducer(state.planning, event);
  const newLead = leadReducer(state.lead, event);
  const newSync = syncReducer(state.sync, event);

  // If no sub-reducer changed, return the same state object (reference equality)
  if (
    newRun === state.run &&
    newTeam === state.team &&
    newNode === state.node &&
    newEdge === state.edge &&
    newMessage === state.message &&
    newHandoff === state.handoff &&
    newArtifact === state.artifact &&
    newDecision === state.decision &&
    newPlanning === state.planning &&
    newLead === state.lead &&
    newSync === state.sync
  ) {
    return state;
  }

  return {
    run: newRun,
    team: newTeam,
    node: newNode,
    edge: newEdge,
    message: newMessage,
    handoff: newHandoff,
    artifact: newArtifact,
    decision: newDecision,
    planning: newPlanning,
    lead: newLead,
    sync: newSync,
  };
};

export { runReducer, type RunState } from "./run";
export { teamReducer, type TeamState } from "./team";
export { nodeReducer, type NodeState } from "./node";
export { edgeReducer, type EdgeState } from "./edge";
export { messageReducer, type MessageState } from "./message";
export { handoffReducer, type HandoffState } from "./handoff";
export { artifactReducer, type ArtifactState } from "./artifact";
export { decisionReducer, type DecisionState } from "./decision";
export { planningReducer, type PlanningState } from "./planning";
export { leadReducer, type LeadState } from "./lead";
export { syncReducer, type SyncReducerState } from "./sync-reducer";
