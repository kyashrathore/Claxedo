/**
 * The string a select uses to key or label an item when the caller supplied no
 * `value` / `label` accessor.
 *
 * Both select generations are generic in their item type but fall back to using the
 * item itself as its own key and label. That fallback is only meaningful for a select
 * OF strings, which is the documented contract for omitting the accessors — this
 * checks it instead of asserting it, so a misuse renders nothing rather than a
 * stringified object.
 */
export function selectItemText(item: unknown): string {
  return typeof item === "string" ? item : ""
}
