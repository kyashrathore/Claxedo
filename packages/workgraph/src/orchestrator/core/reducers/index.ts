import type { EventEnvelope } from "../../events";
import { runReducer, type RunState } from "./run";
import { nodeReducer, type NodeState } from "./node";
import { edgeReducer, type EdgeState } from "./edge";
import { artifactReducer, type ArtifactState } from "./artifact";
import { syncReducer, type SyncReducerState } from "./sync-reducer";

export interface RootState {
  run: RunState;
  node: NodeState;
  edge: EdgeState;
  artifact: ArtifactState;
  sync: SyncReducerState;
}

export const initialRootState: RootState = {
  run: { runs: {} },
  node: { nodes: {} },
  edge: { edges: [] },
  artifact: { artifacts: {} },
  sync: { pushes: [], pulls: [], conflicts: [], snapshots: [], repairs: [] },
};

export const rootReducer = (state: RootState, event: EventEnvelope): RootState => {
  const newRun = runReducer(state.run, event);
  const newNode = nodeReducer(state.node, event);
  const newEdge = edgeReducer(state.edge, event);
  const newArtifact = artifactReducer(state.artifact, event);
  const newSync = syncReducer(state.sync, event);

  // If no sub-reducer changed, return the same state object (reference equality)
  if (
    newRun === state.run &&
    newNode === state.node &&
    newEdge === state.edge &&
    newArtifact === state.artifact &&
    newSync === state.sync
  ) {
    return state;
  }

  return {
    run: newRun,
    node: newNode,
    edge: newEdge,
    artifact: newArtifact,
    sync: newSync,
  };
};

export { runReducer, type RunState } from "./run";
export { nodeReducer, type NodeState } from "./node";
export { edgeReducer, type EdgeState } from "./edge";
export { artifactReducer, type ArtifactState } from "./artifact";
export { syncReducer, type SyncReducerState } from "./sync-reducer";
