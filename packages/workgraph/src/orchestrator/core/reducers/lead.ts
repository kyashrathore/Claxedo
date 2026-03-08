import type { EventEnvelope } from "../../events";

export interface LeadState {
  leadPlans: Record<string, { gaps: string[]; reroutes: string[] }>;
}

export const leadReducer = (state: LeadState, event: EventEnvelope): LeadState => {
  switch (event.type) {
    case "lead_plan_created": {
      try {
        const payload = JSON.parse(event.payload_json);
        return {
          ...state,
          leadPlans: {
            ...state.leadPlans,
            [payload.plan_id]: {
              gaps: [],
              reroutes: [],
            }
          }
        };
      } catch (e) {
        console.warn(`Failed to parse lead_plan_created payload for event ${event.id}`);
        return state;
      }
    }
    case "lead_gap_detected": {
      try {
        const payload = JSON.parse(event.payload_json);
        const plan = state.leadPlans[payload.plan_id];
        if (!plan) return state;
        return {
          ...state,
          leadPlans: {
            ...state.leadPlans,
            [payload.plan_id]: {
              ...plan,
              gaps: [...plan.gaps, payload.gap],
            }
          }
        };
      } catch (e) {
        console.warn(`Failed to parse lead_gap_detected payload for event ${event.id}`);
        return state;
      }
    }
    case "lead_reroute_requested": {
      try {
        const payload = JSON.parse(event.payload_json);
        const plan = state.leadPlans[payload.plan_id];
        if (!plan) return state;
        return {
          ...state,
          leadPlans: {
            ...state.leadPlans,
            [payload.plan_id]: {
              ...plan,
              reroutes: [...plan.reroutes, payload.reroute],
            }
          }
        };
      } catch (e) {
        console.warn(`Failed to parse lead_reroute_requested payload for event ${event.id}`);
        return state;
      }
    }
    default:
      return state;
  }
};
