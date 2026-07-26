// @ts-nocheck
import { createMemo, createSignal, For, Show } from "solid-js"
import { GLYPH_STYLES, glyphIconNames, renderIcon } from "../assets/icons/glyphs"
import { LUCIDE_EQUIVALENT, LUCIDE_GLYPHS, LUCIDE_VIEWBOX } from "../assets/icons/lucide-comparison"
import { UI_CODEX_ICON_ALIASES } from "./codex-icon-map"
import codexSprite from "../assets/icons/codex/sprite.svg"

/**
 * Three-way icon comparison.
 *
 * Codex (extracted, reference only) | Lucide (ISC) | generated (parametric).
 *
 * The weights are normalised so the comparison is about SHAPE, not line weight.
 * Codex is authored at 1.33 on a 20 grid; Lucide at 2 on a 24 grid, which is
 * 1.67 in 20-grid terms — visibly heavier. The stroke control below drives both
 * the Lucide and generated columns in 20-grid units and scales into Lucide's
 * canvas, so setting it to 1.33 puts all three at the same apparent weight.
 */

const CODEX_GRID = 20
const LUCIDE_GRID = 24

function CodexMark(props: { name: string; size: number }) {
  const glyph = () => UI_CODEX_ICON_ALIASES[props.name]
  const present = () => glyph()?.startsWith("codex-20-")
  return (
    <Show when={present()} fallback={<Absent size={props.size} label="no codex glyph" />}>
      <svg width={props.size} height={props.size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <use href={`${codexSprite}#${glyph()}`} />
      </svg>
    </Show>
  )
}

function LucideMark(props: { name: string; size: number; stroke: number; cap: string; join: string }) {
  const icon = () => LUCIDE_EQUIVALENT[props.name]
  const body = () => (icon() ? LUCIDE_GLYPHS[icon()] : undefined)
  // Convert the 20-grid stroke request into Lucide's 24-grid units.
  const stroke = () => (props.stroke * LUCIDE_GRID) / CODEX_GRID
  return (
    <Show when={body()} fallback={<Absent size={props.size} label="unmapped" />}>
      <svg
        width={props.size}
        height={props.size}
        viewBox={LUCIDE_VIEWBOX}
        fill="none"
        stroke="currentColor"
        stroke-width={stroke()}
        stroke-linecap={props.cap}
        stroke-linejoin={props.join}
        aria-hidden="true"
        innerHTML={body()}
      />
    </Show>
  )
}

function GeneratedMark(props: { name: string; size: number; style: object }) {
  const icon = createMemo(() => renderIcon(props.name, props.style))
  return (
    <svg
      width={props.size}
      height={props.size}
      viewBox="0 0 20 20"
      fill="none"
      stroke-width={icon().attributes["stroke-width"]}
      stroke-linecap={icon().attributes["stroke-linecap"]}
      stroke-linejoin={icon().attributes["stroke-linejoin"]}
      aria-hidden="true"
    >
      <g transform={icon().transform}>
        <Show when={icon().stroke}>
          <path d={icon().stroke} stroke="currentColor" />
        </Show>
        <Show when={icon().fill}>
          <path d={icon().fill} fill="currentColor" stroke="none" />
        </Show>
      </g>
    </svg>
  )
}

function Absent(props: { size: number; label: string }) {
  return <span class="ic-absent" title={props.label} style={{ width: `${props.size}px`, height: `${props.size}px` }} />
}

function Comparison() {
  const [stroke, setStroke] = createSignal(GLYPH_STYLES.codex.strokeWidth)
  const [corner, setCorner] = createSignal(GLYPH_STYLES.codex.corner)
  const [cap, setCap] = createSignal("round")
  const [join, setJoin] = createSignal("round")
  const [size, setSize] = createSignal(30)
  const [filter, setFilter] = createSignal("")
  const [onlyCodex, setOnlyCodex] = createSignal(true)

  const style = createMemo(() => ({
    strokeWidth: stroke(),
    corner: corner(),
    rectRadius: 1,
    cap: cap(),
    join: join(),
  }))

  const rows = createMemo(() => {
    const query = filter().trim().toLowerCase()
    return glyphIconNames
      .filter((name) => !onlyCodex() || UI_CODEX_ICON_ALIASES[name]?.startsWith("codex-20-"))
      .filter((name) => !query || name.includes(query) || (LUCIDE_EQUIVALENT[name] ?? "").includes(query))
  })

  return (
    <div class="ic-root">
      <style>{CSS}</style>

      <header>
        <h1>Codex vs Lucide vs generated</h1>
        <p>
          Weights are normalised — Lucide ships at 2 on a 24 grid (1.67 in Codex's 20-grid terms), so the
          stroke control drives both the Lucide and generated columns and scales into Lucide's canvas.
          At 1.33 all three sit at the same apparent weight, and the comparison is about shape alone.
        </p>
      </header>

      <div class="ic-controls">
        <label>
          <span>
            Stroke <b>{stroke().toFixed(2)}</b>
          </span>
          <input type="range" min="0.75" max="2.5" step="0.01" value={stroke()} onInput={(e) => setStroke(+e.currentTarget.value)} />
        </label>
        <label>
          <span>
            Corner <b>{corner().toFixed(2)}</b>
          </span>
          <input type="range" min="0" max="4" step="0.05" value={corner()} onInput={(e) => setCorner(+e.currentTarget.value)} />
          <em>generated column only — Codex and Lucide are flattened paths</em>
        </label>
        <label>
          <span>
            Size <b>{size()}px</b>
          </span>
          <input type="range" min="18" max="64" step="1" value={size()} onInput={(e) => setSize(+e.currentTarget.value)} />
        </label>
        <label class="ic-inline">
          <span>Cap</span>
          <select value={cap()} onChange={(e) => setCap(e.currentTarget.value)}>
            <option>round</option>
            <option>square</option>
            <option>butt</option>
          </select>
        </label>
        <label class="ic-inline">
          <span>Join</span>
          <select value={join()} onChange={(e) => setJoin(e.currentTarget.value)}>
            <option>round</option>
            <option>miter</option>
            <option>bevel</option>
          </select>
        </label>
        <label class="ic-inline">
          <span>Filter</span>
          <input type="search" value={filter()} placeholder="name" onInput={(e) => setFilter(e.currentTarget.value)} />
        </label>
        <label class="ic-inline">
          <span>Only names Codex actually has</span>
          <input type="checkbox" checked={onlyCodex()} onChange={(e) => setOnlyCodex(e.currentTarget.checked)} />
        </label>
      </div>

      <div class="ic-head">
        <span>icon</span>
        <span class="ic-col ic-codex">Codex</span>
        <span class="ic-col ic-lucide">Lucide</span>
        <span class="ic-col ic-gen">generated</span>
      </div>

      <div class="ic-rows">
        <For each={rows()}>
          {(name) => (
            <div class="ic-row">
              <div class="ic-name">
                <code>{name}</code>
                <small>{LUCIDE_EQUIVALENT[name] ?? "—"}</small>
              </div>
              <div class="ic-col ic-codex">
                <CodexMark name={name} size={size()} />
              </div>
              <div class="ic-col ic-lucide">
                <LucideMark name={name} size={size()} stroke={stroke()} cap={cap()} join={join()} />
              </div>
              <div class="ic-col ic-gen">
                <GeneratedMark name={name} size={size()} style={style()} />
              </div>
            </div>
          )}
        </For>
      </div>

      <p class="ic-count">{rows().length} icons</p>
    </div>
  )
}

const CSS = `
.ic-root { padding: 24px; font-family: ui-sans-serif, -apple-system, system-ui, sans-serif; color: #e8e8e8; background: #161616; min-height: 100vh; }
.ic-root header h1 { font-size: 18px; font-weight: 600; margin: 0 0 4px; }
.ic-root header p { margin: 0 0 18px; font-size: 12.5px; color: #8e8e8e; max-width: 88ch; line-height: 1.55; }
.ic-controls { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px 22px; padding: 15px 18px; background: #1e1e1e; border: 1px solid #2e2e2e; border-radius: 12px; margin-bottom: 18px; position: sticky; top: 0; z-index: 5; }
.ic-controls label { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: #aaa; }
.ic-controls label span { display: flex; justify-content: space-between; gap: 8px; }
.ic-controls b { color: #fff; font-variant-numeric: tabular-nums; }
.ic-controls em { font-style: normal; font-size: 10.5px; color: #6a6a6a; }
.ic-controls input[type=range] { accent-color: #e8e8e8; width: 100%; }
.ic-controls .ic-inline { flex-direction: row; align-items: center; justify-content: space-between; }
.ic-controls select, .ic-controls input[type=search] { background: #262626; color: #e8e8e8; border: 1px solid #3a3a3a; border-radius: 6px; padding: 5px 8px; font-size: 12px; min-width: 0; }
.ic-head, .ic-row { display: grid; grid-template-columns: minmax(150px, 1.4fr) 1fr 1fr 1fr; align-items: center; gap: 10px; }
.ic-head { padding: 0 12px 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #7a7a7a; border-bottom: 1px solid #2a2a2a; }
.ic-head .ic-col { text-align: center; }
.ic-head .ic-codex { color: #7d7d7d; }
.ic-head .ic-lucide { color: #7fb0d8; }
.ic-head .ic-gen { color: #e8e8e8; }
.ic-rows { display: flex; flex-direction: column; }
.ic-row { padding: 9px 12px; border-bottom: 1px solid #212121; }
.ic-row:hover { background: #1c1c1c; }
.ic-name { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.ic-name code { font-size: 11.5px; color: #cfcfcf; font-family: ui-monospace, SFMono-Regular, monospace; overflow-wrap: anywhere; }
.ic-name small { font-size: 10px; color: #6a6a6a; }
.ic-col { display: flex; align-items: center; justify-content: center; }
.ic-row .ic-codex { color: #8a8a8a; }
.ic-row .ic-lucide { color: #9ccbf0; }
.ic-row .ic-gen { color: #f2f2f2; }
.ic-absent { display: inline-block; border: 1px dashed #333; border-radius: 5px; }
.ic-count { margin: 14px 0 0; font-size: 12px; color: #777; }
`

export default {
  title: "Foundations/Icon comparison",
  parameters: { layout: "fullscreen" },
}

export const ThreeWay = () => <Comparison />
