import type { EventEnvelope } from "../../events";

export interface TeamState {
  teams: Record<string, { name: string; status: string; members: string[] }>;
}

export const teamReducer = (state: TeamState, event: EventEnvelope): TeamState => {
  switch (event.type) {
    case "team_created": {
      try {
        const payload = JSON.parse(event.payload_json);
        return {
          ...state,
          teams: {
            ...state.teams,
            [payload.team_id]: {
              name: payload.name,
              status: "active",
              members: [],
            }
          }
        };
      } catch (e) {
        console.warn(`Failed to parse team_created payload for event ${event.id}`);
        return state;
      }
    }
    case "team_status_changed": {
      try {
        const payload = JSON.parse(event.payload_json);
        const team = state.teams[payload.team_id];
        if (!team) return state;
        return {
          ...state,
          teams: {
            ...state.teams,
            [payload.team_id]: {
              ...team,
              status: payload.status,
            }
          }
        };
      } catch (e) {
        console.warn(`Failed to parse team_status_changed payload for event ${event.id}`);
        return state;
      }
    }
    case "team_member_added": {
      try {
        const payload = JSON.parse(event.payload_json);
        const team = state.teams[payload.team_id];
        if (!team) return state;
        return {
          ...state,
          teams: {
            ...state.teams,
            [payload.team_id]: {
              ...team,
              members: [...team.members, payload.agent_id],
            }
          }
        };
      } catch (e) {
        console.warn(`Failed to parse team_member_added payload for event ${event.id}`);
        return state;
      }
    }
    default:
      return state;
  }
};
