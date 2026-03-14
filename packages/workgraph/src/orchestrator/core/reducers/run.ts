import type { EventEnvelope } from "../../events";

export interface RunState {
  runs: Record<string, { goal: string; status: "active" | "planned" | "completed" | "failed" }>;
}

export const runReducer = (state: RunState, event: EventEnvelope): RunState => {
  switch (event.type) {
    case "run_created": {
      try {
        const payload = JSON.parse(event.payload_json);
        return {
          ...state,
          runs: {
            ...state.runs,
            [event.run_id]: {
              goal: payload.goal,
              status: "active"
            }
          }
        };
      } catch (e) {
        // If malformed payload, just ignore and return existing state to preserve immutability
        console.warn(`Failed to parse run_created payload for event ${event.id}`);
        return state;
      }
    }
    case "run_planned": {
      const run = state.runs[event.run_id];
      if (!run) return state;
      return {
        ...state,
        runs: {
          ...state.runs,
          [event.run_id]: {
            ...run,
            status: "planned",
          }
        }
      };
    }
    case "run_completed": {
      const run = state.runs[event.run_id];
      if (!run) return state;
      return {
        ...state,
        runs: {
          ...state.runs,
          [event.run_id]: {
            ...run,
            status: "completed",
          }
        }
      };
    }
    case "run_failed": {
      const run = state.runs[event.run_id];
      if (!run) return state;
      return {
        ...state,
        runs: {
          ...state.runs,
          [event.run_id]: {
            ...run,
            status: "failed",
          }
        }
      };
    }
    default:
      return state;
  }
};
