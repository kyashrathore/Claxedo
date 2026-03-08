import type { EventEnvelope } from "../../events";

export interface MessageState {
  messages: Array<{ id: string; team_id: string; sender_id: string; content: string; type: string }>;
}

export const messageReducer = (state: MessageState, event: EventEnvelope): MessageState => {
  switch (event.type) {
    case "message_posted": {
      try {
        const payload = JSON.parse(event.payload_json);
        return {
          ...state,
          messages: [
            ...state.messages,
            {
              id: payload.id,
              team_id: payload.team_id,
              sender_id: payload.sender_id,
              content: payload.content,
              type: payload.message_type,
            }
          ]
        };
      } catch (e) {
        console.warn(`Failed to parse message_posted payload for event ${event.id}`);
        return state;
      }
    }
    default:
      return state;
  }
};
