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
import type { TextInputEvent } from "@native-sdk/core/text";
import { claxedoLoadTranscript, claxedoSendPrompt } from "@native-sdk/services";
import type { PromptRequest, StreamRequest, TranscriptResult } from "./shared.ts";

const DRAFT_CAPACITY = 16384;

/// Minimal caret-at-end editor: insert appends, delete_backward removes one
/// UTF-8 character, clear empties. Caret/selection fidelity returns with the
/// SDK engine.
function applyDraftEvent(text: Uint8Array, event: TextInputEvent): Uint8Array | null {
  switch (event.kind) {
    case "insert_text": {
      if (text.length + event.text.length > DRAFT_CAPACITY) return null;
      const merged = new Uint8Array(text.length + event.text.length);
      merged.set(text, 0);
      merged.set(event.text, text.length);
      return merged;
    }
    case "delete_backward": {
      if (text.length === 0) return text;
      let end = text.length - 1;
      while (end > 0 && (text[end] & 0xc0) === 0x80) {
        end = end - 1;
      }
      return text.slice(0, end);
    }
    case "clear":
      return utf8Bytes("");
    default:
      return text;
  }
}

export interface Row {
  readonly id: number;
  readonly isUser: boolean;
  readonly isAssistant: boolean;
  readonly isOther: boolean;
  readonly body: Uint8Array;
}

export interface Model {
  readonly title: Uint8Array;
  readonly connection: Uint8Array;
  readonly rows: readonly Row[];
  readonly draft: Uint8Array;
  readonly sending: boolean;
  readonly polling: boolean;
  /** Derived, maintained by update — markup binds fields, and the runtime
   * wires fields more reliably than helper bindings today. */
  readonly hasRows: boolean;
  readonly sendDisabled: boolean;
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

export function initialModel(): Model {
  return {
    title: utf8Bytes("Claxedo session"),
    connection: utf8Bytes("connecting"),
    rows: [],
    draft: utf8Bytes(""),
    sending: false,
    polling: true,
    hasRows: false,
    sendDisabled: true,
  };
}

/** Re-derives the maintained booleans after any rows/draft/sending change. */
function derived(model: Model): Model {
  const hasRows = model.rows.length > 0;
  const sendDisabled = model.sending || model.draft.length === 0;
  if (model.hasRows === hasRows && model.sendDisabled === sendDisabled) return model;
  return { ...model, hasRows, sendDisabled };
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
      isOther: false,
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
      return derived({
        ...model,
        connection: utf8Bytes("live"),
        rows: seededRows(msg.result),
        title: msg.result.title.length > 0 ? msg.result.title : model.title,
      });
    case "transcript_failed":
      return { ...model, connection: utf8Bytes("error") };
    case "draft_input": {
      const next = applyDraftEvent(model.draft, msg.edit);
      if (next === null) return model;
      return derived({ ...model, draft: next });
    }
    case "submit": {
      if (model.sending || model.draft.length === 0) return model;
      const prompt: PromptRequest = { directory: utf8Bytes("/root/session-app-real"), text: model.draft };
      const rows = model.rows.slice();
      rows.push({ id: rows.length + 1, isUser: true, isAssistant: false, isOther: false, body: model.draft });
      return [
        derived({ ...model, rows, draft: utf8Bytes(""), sending: true }),
        claxedoSendPrompt(prompt, { key: "prompt", ok: "prompt_sent", err: "prompt_failed" }),
      ];
    }
    case "prompt_sent": {
      const reloaded = seededRows(msg.result);
      return derived({ ...model, sending: false, rows: reloaded.length > 0 ? reloaded : model.rows });
    }
    case "prompt_failed": {
      const rows = model.rows.slice();
      rows.push({ id: rows.length + 1, isUser: false, isAssistant: false, isOther: true, body: msg.error });
      return derived({ ...model, sending: false, rows });
    }
  }
}

export function subscriptions(model: Model): Sub<Msg> {
  if (!model.polling) return Sub.none;
  return Sub.timer("poll", 1000, "tick");
}
