import { Schema } from "effect"
import { HttpApiSchema } from "effect/unstable/httpapi"

/**
 * Build a JSON-data SSE response without letting Effect reuse the decoded
 * payload's OpenAPI identifier for the transport's JSON-string schema.
 *
 * `HttpApiSchema.StreamSse({ data })` intentionally exposes a stream of the
 * decoded data values while its wire event contains a JSON string. Effect
 * derives both schemas from the same annotated payload, so an identified
 * payload can otherwise produce a self-referencing OpenAPI component. Keep
 * Effect's data-mode stream and replace only its wire codec with one whose
 * JSON-string wrapper has its own explicit identifier.
 */
export function jsonDataStreamSse<Data extends Schema.Top>(data: Data, streamIdentifier: string) {
  const stream = HttpApiSchema.StreamSse({ data })
  const events = Schema.Struct({
    id: Schema.UndefinedOr(Schema.String),
    event: Schema.String,
    data: Schema.fromJsonString(data).annotate({ identifier: streamIdentifier }),
  })

  return Object.assign(stream, { events })
}
