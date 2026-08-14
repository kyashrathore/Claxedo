// The native session core — the same fold shape as `../src/core/update.ts`,
// adapted to the app-core subset (U10 verdict: LOGIC ports, REPRESENTATION
// adapts — text is bytes, messages are `kind`-tagged, effects are Cmd data).
//
// v1 liveness is POLLING: services are synchronous today and the streaming
// channel delivers canonical bytes the core has no decoder for yet, so a
// 1-second timer reloads the transcript through the claxedo service. The
// SSE bridge (spawned curl + readSync + emit) is written and checked in
// `services/claxedo.ts` for the day the channel decode lands.

import { Cmd, Sub, utf8Bytes } from "@native-sdk/core";
import { claxedoLoadTranscript, claxedoSendPrompt } from "@native-sdk/services";
import type { PromptRequest, StreamRequest, TranscriptResult } from "./shared.ts";

const DRAFT_CAPACITY = 16384;

// The runtime text-control vocabulary, mirrored structurally (matching stays
// structural across the emission boundary). Mirrored HERE instead of importing
// `@native-sdk/core/text` because that module's own engine does not clear the
// external core compiler's integer-proof pass in SDK 0.9.0 (SC4022/SC4023 in
// sdk/text.ts) — recorded upstream finding; swap back to the SDK engine when
// it proves.
export interface TextRange {
  readonly start: number;
  readonly end: number;
}

export interface TextSelection {
  readonly anchor: number;
  readonly focus: number;
}

export type TextCaretDirection =
  | "previous"
  | "next"
  | "previous_word"
  | "next_word"
  | "start"
  | "end";

export interface TextCaretMove {
  readonly direction: TextCaretDirection;
  readonly extend: boolean;
}

export type TextInputEvent =
  | { readonly kind: "insert_text"; readonly text: Uint8Array }
  | { readonly kind: "delete_backward" }
  | { readonly kind: "delete_forward" }
  | { readonly kind: "delete_word_backward" }
  | { readonly kind: "delete_word_forward" }
  | { readonly kind: "clear" }
  | { readonly kind: "move_caret"; readonly move: TextCaretMove }
  | { readonly kind: "set_selection"; readonly selection: TextSelection }
  | { readonly kind: "set_composition"; readonly text: Uint8Array; readonly cursor: number | null }
  | { readonly kind: "commit_composition" }
  | { readonly kind: "cancel_composition" };

export interface TextEditState {
  readonly text: Uint8Array;
  readonly selection: TextSelection;
  readonly composition: TextRange | null;
}

/// Minimal caret-at-end editor: insert appends, delete_backward removes one
/// UTF-8 character, clear empties. Caret/selection fidelity returns with the
/// SDK engine.
function applyDraftEvent(state: TextEditState, event: TextInputEvent): TextEditState | null {
  switch (event.kind) {
    case "insert_text": {
      if (state.text.length + event.text.length > DRAFT_CAPACITY) return null;
      const merged = new Uint8Array(state.text.length + event.text.length);
      merged.set(state.text, 0);
      merged.set(event.text, state.text.length);
      return { text: merged, selection: { anchor: merged.length, focus: merged.length }, composition: null };
    }
    case "delete_backward": {
      if (state.text.length === 0) return state;
      let end = state.text.length - 1;
      while (end > 0 && (state.text[end] & 0xc0) === 0x80) {
        end = end - 1;
      }
      const trimmed = state.text.slice(0, end);
      return { text: trimmed, selection: { anchor: trimmed.length, focus: trimmed.length }, composition: null };
    }
    case "clear":
      return { text: utf8Bytes(""), selection: { anchor: 0, focus: 0 }, composition: null };
    default:
      return state;
  }
}

export interface Row {
  readonly id: number;
  readonly isUser: boolean;
  readonly isAssistant: boolean;
  readonly body: Uint8Array;
}

export interface Model {
  readonly title: Uint8Array;
  readonly connection: Uint8Array;
  readonly rows: readonly Row[];
  readonly draft: TextEditState;
  readonly sending: boolean;
  readonly polling: boolean;
}

export type Msg =
  | { readonly kind: "boot" }
  | { readonly kind: "tick"; readonly at: number }
  | { readonly kind: "transcript_loaded"; readonly result: TranscriptResult }
  | { readonly kind: "transcript_failed"; readonly error: Uint8Array }
  | { readonly kind: "draft_input"; readonly edit: TextInputEvent }
  | { readonly kind: "submit" }
  | { readonly kind: "prompt_sent"; readonly result: TranscriptResult }
  | { readonly kind: "prompt_failed"; readonly error: Uint8Array };

export const viewUnbound = [
  "boot",
  "tick",
  "transcript_loaded",
  "transcript_failed",
  "prompt_sent",
  "prompt_failed",
  "polling",
] as const;

function emptyDraft(): TextEditState {
  return {
    text: utf8Bytes(""),
    selection: { anchor: 0, focus: 0 },
    composition: null,
  };
}

export function initialModel(): Model {
  return {
    title: utf8Bytes("Claxedo session"),
    connection: utf8Bytes("connecting"),
    rows: [],
    draft: emptyDraft(),
    sending: false,
    polling: true,
  };
}

export function hasRows(model: Model): boolean {
  return model.rows.length > 0;
}

export function canSend(model: Model): boolean {
  return !model.sending && model.draft.text.length > 0;
}

function request(): StreamRequest {
  return { directory: utf8Bytes("/root/session-app-real") };
}

function seededRows(result: TranscriptResult): Row[] {
  const rows: Row[] = [];
  for (const [index, item] of result.rows.entries()) {
    rows.push({
      id: index + 1,
      isUser: item.isUser,
      isAssistant: !item.isUser,
      body: item.body,
    });
  }
  return rows;
}

export function update(model: Model, msg: Msg): Model | [Model, Cmd<Msg>] {
  switch (msg.kind) {
    case "boot":
      return [model, claxedoLoadTranscript(request(), { key: "transcript", ok: "transcript_loaded", err: "transcript_failed" })];
    case "tick":
      return [model, claxedoLoadTranscript(request(), { key: "transcript", ok: "transcript_loaded", err: "transcript_failed" })];
    case "transcript_loaded":
      return {
        ...model,
        connection: utf8Bytes("live"),
        rows: seededRows(msg.result),
        title: msg.result.title.length > 0 ? msg.result.title : model.title,
      };
    case "transcript_failed":
      return { ...model, connection: utf8Bytes("error") };
    case "draft_input": {
      const next = applyDraftEvent(model.draft, msg.edit);
      if (next === null) return model;
      return { ...model, draft: next };
    }
    case "submit": {
      if (model.sending || model.draft.text.length === 0) return model;
      const prompt: PromptRequest = { directory: utf8Bytes("/root/session-app-real"), text: model.draft.text };
      const rows = model.rows.slice();
      rows.push({ id: rows.length + 1, isUser: true, isAssistant: false, body: model.draft.text });
      return [
        { ...model, rows, draft: emptyDraft(), sending: true },
        claxedoSendPrompt(prompt, { key: "prompt", ok: "prompt_sent", err: "prompt_failed" }),
      ];
    }
    case "prompt_sent":
      return { ...model, sending: false, rows: seededRows(msg.result).length > 0 ? seededRows(msg.result) : model.rows };
    case "prompt_failed": {
      const rows = model.rows.slice();
      rows.push({ id: rows.length + 1, isUser: false, isAssistant: false, body: msg.error });
      return { ...model, sending: false, rows };
    }
  }
}

export function subscriptions(model: Model): Sub<Msg> {
  if (!model.polling) return Sub.none;
  return Sub.timer("poll", 1000, "tick");
}
