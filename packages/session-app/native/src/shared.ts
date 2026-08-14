// Boundary shapes shared by the core and the claxedo service — contract-
// encodable data only (bytes, booleans, numbers, records, readonly slices).

export type StreamRequest = {
  readonly directory: Uint8Array;
};

export type PromptRequest = {
  readonly directory: Uint8Array;
  readonly text: Uint8Array;
};

export type SessionsResult = {
  readonly ids: readonly Uint8Array[];
};

export type TranscriptRow = {
  readonly isUser: boolean;
  readonly body: Uint8Array;
};

export type TranscriptResult = {
  readonly sessionId: Uint8Array;
  readonly title: Uint8Array;
  readonly rows: readonly TranscriptRow[];
};

/**
 * One runtime event, pre-classified by the service so the core (and the
 * markup) branch on booleans instead of parsing — the AgentRuntimeEvent
 * vocabulary crosses the boundary as flags + bytes.
 */
export type EventChunk = {
  readonly isTextDelta: boolean;
  readonly isThinkingDelta: boolean;
  readonly isStepStart: boolean;
  readonly isTool: boolean;
  readonly isStatus: boolean;
  readonly isTitle: boolean;
  readonly isNotice: boolean;
  readonly isFinish: boolean;
  readonly text: Uint8Array;
  readonly toolName: Uint8Array;
  readonly toolStatus: Uint8Array;
  readonly toolSummary: Uint8Array;
};

export type StreamResult = {
  readonly closed: boolean;
};
