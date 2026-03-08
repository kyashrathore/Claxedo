import type { EventEnvelope } from "../../events";

export interface PlanningState {
  plans: Record<string, { questions: string[]; routes: Record<string, { team_id: string; confidence: number }>; dispatched: boolean }>;
}

export const planningReducer = (state: PlanningState, event: EventEnvelope): PlanningState => {
  switch (event.type) {
    case "run_planned": {
      try {
        const payload = JSON.parse(event.payload_json);
        return {
          ...state,
          plans: {
            ...state.plans,
            [event.run_id]: {
              questions: [],
              routes: {},
              dispatched: false,
            }
          }
        };
      } catch (e) {
        console.warn(`Failed to parse run_planned payload for event ${event.id}`);
        return state;
      }
    }
    case "question_scoped": {
      try {
        const payload = JSON.parse(event.payload_json);
        const plan = state.plans[event.run_id];
        if (!plan) return state;
        return {
          ...state,
          plans: {
            ...state.plans,
            [event.run_id]: {
              ...plan,
              questions: [...plan.questions, payload.question],
            }
          }
        };
      } catch (e) {
        console.warn(`Failed to parse question_scoped payload for event ${event.id}`);
        return state;
      }
    }
    case "route_scored": {
      try {
        const payload = JSON.parse(event.payload_json);
        const plan = state.plans[event.run_id];
        if (!plan) return state;
        return {
          ...state,
          plans: {
            ...state.plans,
            [event.run_id]: {
              ...plan,
              routes: {
                ...plan.routes,
                [payload.route_id]: {
                  team_id: payload.team_id,
                  confidence: payload.confidence,
                }
              }
            }
          }
        };
      } catch (e) {
        console.warn(`Failed to parse route_scored payload for event ${event.id}`);
        return state;
      }
    }
    case "route_selected": {
      try {
        const payload = JSON.parse(event.payload_json);
        const plan = state.plans[event.run_id];
        if (!plan) return state;
        // Mark the selected route — keep routes as is, just note the selection
        return {
          ...state,
          plans: {
            ...state.plans,
            [event.run_id]: {
              ...plan,
            }
          }
        };
      } catch (e) {
        console.warn(`Failed to parse route_selected payload for event ${event.id}`);
        return state;
      }
    }
    case "dispatch_requested": {
      try {
        const payload = JSON.parse(event.payload_json);
        const plan = state.plans[event.run_id];
        if (!plan) return state;
        return {
          ...state,
          plans: {
            ...state.plans,
            [event.run_id]: {
              ...plan,
              dispatched: true,
            }
          }
        };
      } catch (e) {
        console.warn(`Failed to parse dispatch_requested payload for event ${event.id}`);
        return state;
      }
    }
    default:
      return state;
  }
};
