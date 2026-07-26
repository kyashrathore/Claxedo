/**
 * ⚠️ UNRESOLVED LICENCE RISK — KNOWN AND ACCEPTED FOR NOW.
 *
 * The glyphs behind this sprite were extracted from the ChatGPT desktop app
 * (`/Applications/ChatGPT.app/Contents/Resources/app.asar`). The provenance is
 * recorded in `../assets/icons/codex/manifest.json`, which carries the source
 * path, a byte offset and a SHA-256 per icon.
 *
 * Two things are worth knowing before anyone relies on this:
 *
 * 1. The artwork is NOT from `openai/codex`. That repository is Apache-2.0, but
 *    it contains five SVGs, all skill sample art — none of these 154 interface
 *    glyphs. These came from the proprietary desktop app, which is not open
 *    source. The Apache licence does not cover them.
 *
 * 2. The path data is a byte-identical copy, not a redraw. Sampling six glyphs
 *    and searching the shipped renderer bundle for their `d` attributes matched
 *    all six exactly.
 *
 * This is retained deliberately: the visual work depends on it and nobody has
 * raised it. Treat it as technical debt with a legal shape, not as settled.
 *
 * If it is ever challenged, the exposure is redistribution rather than use, so
 * the order of operations is:
 *   - `src/assets/icons/codex/*` has already been dropped from `files` in
 *     package.json, so it no longer ships in the public npm tarball;
 *   - the remaining exposure is the public git history of this repository;
 *   - replacing the set is the real fix. Lucide (ISC, ~2000 icons, centre-line
 *     strokes on a 24 grid) was evaluated and is a clean drop-in target.
 *     Hugeicons was evaluated and rejected: npm says MIT, but the vendor's own
 *     licence agreement covers the free tier and forbids redistributing SVG
 *     source, which is exactly what this repo does.
 */
import sprite from "../assets/icons/codex/sprite.svg"

export const codexIconSprite = sprite
