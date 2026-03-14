import type { EventEnvelope } from "../../events";

export interface ArtifactState {
  artifacts: Record<string, { node_id: string; content: string; version: number }>;
}

export const artifactReducer = (state: ArtifactState, event: EventEnvelope): ArtifactState => {
  switch (event.type) {
    case "artifact_created": {
      try {
        const payload = JSON.parse(event.payload_json);
        return {
          ...state,
          artifacts: {
            ...state.artifacts,
            [payload.id]: {
              node_id: payload.node_id,
              content: payload.content,
              version: payload.version,
            }
          }
        };
      } catch (e) {
        console.warn(`Failed to parse artifact_created payload for event ${event.id}`);
        return state;
      }
    }
    case "scratchpad_promoted": {
      try {
        const payload = JSON.parse(event.payload_json);
        return {
          ...state,
          artifacts: {
            ...state.artifacts,
            [payload.id]: {
              node_id: payload.node_id,
              content: payload.content,
              version: payload.version,
            }
          }
        };
      } catch (e) {
        console.warn(`Failed to parse scratchpad_promoted payload for event ${event.id}`);
        return state;
      }
    }
    default:
      return state;
  }
};
