// @ts-nocheck
import { createMemo, createSignal, For, Show } from "solid-js"
import { GLYPH_STYLES, ICON_BINDINGS, glyphIconNames, renderIcon } from "../assets/icons/glyphs"
import { UI_CODEX_ICON_ALIASES } from "./codex-icon-map"
import codexSprite from "../assets/icons/codex/sprite.svg"

/**
 * Live workbench for the parametric glyph system.
 *
 * The left glyph in each cell is generated from geometry primitives at render
 * time; the right one is the extracted Codex asset, kept here purely as a
 * visual reference while the new set is being tuned. Every control below feeds
 * straight into the renderer, so what you see is what the sprite will contain.
 */

const PRESETS = Object.keys(GLYPH_STYLES) as (keyof typeof GLYPH_STYLES)[]

function GeneratedGlyph(props: { name: string; style: object; size: number }) {
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

function CodexGlyph(props: { name: string; size: number }) {
  const glyph = () => UI_CODEX_ICON_ALIASES[props.name]
  // The codex-custom-* names never lived in the extracted sprite; they were
  // hand-drawn locally, so there is nothing to compare against here.
  const inSprite = () => glyph()?.startsWith("codex-20-")
  return (
    <Show
      when={inSprite()}
      fallback={<span class="gs-absent" style={{ width: `${props.size}px`, height: `${props.size}px` }} />}
    >
      <svg width={props.size} height={props.size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <use href={`${codexSprite}#${glyph()}`} />
      </svg>
    </Show>
  )
}

function Workbench() {
  // Open on the measured Codex calibration, so the two columns start matched
  // and the knob's effect is visible as a departure from that baseline.
  const [preset, setPreset] = createSignal("codex")
  const [strokeWidth, setStrokeWidth] = createSignal(GLYPH_STYLES.codex.strokeWidth)
  const [corner, setCorner] = createSignal(GLYPH_STYLES.codex.corner)
  const [rectRadius, setRectRadius] = createSignal(GLYPH_STYLES.codex.rectRadius)
  const [cap, setCap] = createSignal(GLYPH_STYLES.codex.cap)
  const [join, setJoin] = createSignal(GLYPH_STYLES.codex.join)
  const [size, setSize] = createSignal(24)
  const [compare, setCompare] = createSignal(true)
  const [filter, setFilter] = createSignal("")

  function applyPreset(name: string) {
    const next = GLYPH_STYLES[name]
    setPreset(name)
    setStrokeWidth(next.strokeWidth)
    setCorner(next.corner)
    setRectRadius(next.rectRadius)
    setCap(next.cap)
    setJoin(next.join)
  }

  const style = createMemo(() => ({
    strokeWidth: strokeWidth(),
    corner: corner(),
    rectRadius: rectRadius(),
    cap: cap(),
    join: join(),
  }))

  const shown = createMemo(() => {
    const query = filter().trim().toLowerCase()
    if (!query) return glyphIconNames
    return glyphIconNames.filter(
      (name) => name.includes(query) || ICON_BINDINGS[name].shape.includes(query),
    )
  })

  return (
    <div class="gs-root">
      <style>{CSS}</style>

      <header class="gs-head">
        <div>
          <h1>Glyph system</h1>
          <p>
            {glyphIconNames.length} icons generated from{" "}
            {new Set(Object.values(ICON_BINDINGS).map((b) => b.shape)).size} geometric shapes. Every
            control writes straight into the renderer.
          </p>
        </div>
        <div class="gs-presets">
          <For each={PRESETS}>
            {(name) => (
              <button
                type="button"
                class="gs-preset"
                data-active={preset() === name ? "true" : undefined}
                onClick={() => applyPreset(name)}
              >
                {name}
              </button>
            )}
          </For>
        </div>
      </header>

      <div class="gs-controls">
        <label class="gs-control">
          <span>
            Corner radius <b>{corner().toFixed(2)}</b>
          </span>
          <input
            type="range"
            min="0"
            max="4"
            step="0.05"
            value={corner()}
            onInput={(e) => setCorner(Number(e.currentTarget.value))}
          />
          <em>Baked into the path — this is the knob stroke-linejoin cannot give you.</em>
        </label>

        <label class="gs-control">
          <span>
            Stroke width <b>{strokeWidth().toFixed(2)}</b>
          </span>
          <input
            type="range"
            min="0.75"
            max="2.5"
            step="0.05"
            value={strokeWidth()}
            onInput={(e) => setStrokeWidth(Number(e.currentTarget.value))}
          />
        </label>

        <label class="gs-control">
          <span>
            Rect radius ×<b>{rectRadius().toFixed(2)}</b>
          </span>
          <input
            type="range"
            min="0"
            max="2"
            step="0.05"
            value={rectRadius()}
            onInput={(e) => setRectRadius(Number(e.currentTarget.value))}
          />
        </label>

        <label class="gs-control">
          <span>
            Render size <b>{size()}px</b>
          </span>
          <input
            type="range"
            min="14"
            max="64"
            step="1"
            value={size()}
            onInput={(e) => setSize(Number(e.currentTarget.value))}
          />
        </label>

        <label class="gs-control gs-control-inline">
          <span>Line cap</span>
          <select value={cap()} onChange={(e) => setCap(e.currentTarget.value)}>
            <option value="round">round</option>
            <option value="square">square</option>
            <option value="butt">butt</option>
          </select>
        </label>

        <label class="gs-control gs-control-inline">
          <span>Line join</span>
          <select value={join()} onChange={(e) => setJoin(e.currentTarget.value)}>
            <option value="round">round</option>
            <option value="miter">miter</option>
            <option value="bevel">bevel</option>
          </select>
        </label>

        <label class="gs-control gs-control-inline">
          <span>Filter</span>
          <input
            type="search"
            placeholder="name or shape"
            value={filter()}
            onInput={(e) => setFilter(e.currentTarget.value)}
          />
        </label>

        <label class="gs-control gs-control-inline">
          <span>Compare with Codex</span>
          <input type="checkbox" checked={compare()} onChange={(e) => setCompare(e.currentTarget.checked)} />
        </label>
      </div>

      <Show when={compare()}>
        <p class="gs-legend">
          <span class="gs-swatch gs-swatch-new" /> generated
          <span class="gs-swatch gs-swatch-old" /> extracted Codex asset (reference only)
        </p>
      </Show>

      <div class="gs-grid" data-compare={compare() ? "true" : undefined}>
        <For each={shown()}>
          {(name) => (
            <figure class="gs-cell">
              <div class="gs-marks">
                <span class="gs-mark gs-mark-new">
                  <GeneratedGlyph name={name} style={style()} size={size()} />
                </span>
                <Show when={compare()}>
                  <span class="gs-mark gs-mark-old">
                    <CodexGlyph name={name} size={size()} />
                  </span>
                </Show>
              </div>
              <figcaption>
                <code>{name}</code>
                <Show when={ICON_BINDINGS[name].shape !== name}>
                  <small>{ICON_BINDINGS[name].shape}</small>
                </Show>
              </figcaption>
            </figure>
          )}
        </For>
      </div>

      <Show when={shown().length === 0}>
        <p class="gs-empty">Nothing matches “{filter()}”.</p>
      </Show>
    </div>
  )
}

const CSS = `
.gs-root { padding: 24px; font-family: ui-sans-serif, -apple-system, system-ui, sans-serif; color: #e8e8e8; background: #161616; min-height: 100vh; }
.gs-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; flex-wrap: wrap; margin-bottom: 20px; }
.gs-head h1 { font-size: 18px; font-weight: 600; margin: 0 0 4px; }
.gs-head p { margin: 0; font-size: 13px; color: #999; max-width: 62ch; line-height: 1.5; }
.gs-presets { display: flex; gap: 6px; }
.gs-preset { padding: 6px 14px; border-radius: 7px; border: 1px solid #3a3a3a; background: #222; color: #ccc; font-size: 13px; cursor: pointer; text-transform: capitalize; }
.gs-preset[data-active] { background: #e8e8e8; color: #161616; border-color: #e8e8e8; font-weight: 600; }
.gs-controls { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 14px 22px; padding: 16px 18px; background: #1e1e1e; border: 1px solid #2e2e2e; border-radius: 12px; margin-bottom: 16px; position: sticky; top: 0; z-index: 5; }
.gs-control { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: #aaa; }
.gs-control span { display: flex; justify-content: space-between; gap: 8px; }
.gs-control b { color: #fff; font-variant-numeric: tabular-nums; font-weight: 600; }
.gs-control em { font-style: normal; font-size: 11px; color: #6d6d6d; line-height: 1.35; }
.gs-control input[type=range] { width: 100%; accent-color: #e8e8e8; }
.gs-control-inline { flex-direction: row; align-items: center; justify-content: space-between; gap: 10px; }
.gs-control select, .gs-control input[type=search] { background: #262626; color: #e8e8e8; border: 1px solid #3a3a3a; border-radius: 6px; padding: 5px 8px; font-size: 12px; min-width: 0; }
.gs-legend { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #888; margin: 0 0 12px; }
.gs-swatch { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
.gs-swatch-new { background: #e8e8e8; margin-left: 4px; }
.gs-swatch-old { background: #5c5c5c; margin-left: 14px; }
.gs-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(132px, 1fr)); gap: 8px; }
.gs-cell { margin: 0; padding: 12px 8px 9px; border: 1px solid #262626; border-radius: 10px; background: #1c1c1c; display: flex; flex-direction: column; align-items: center; gap: 9px; }
.gs-cell:hover { border-color: #3d3d3d; background: #212121; }
.gs-marks { display: flex; align-items: center; justify-content: center; gap: 12px; min-height: 40px; }
.gs-grid[data-compare] .gs-marks { padding-bottom: 2px; }
.gs-mark { display: inline-flex; align-items: center; justify-content: center; }
.gs-mark-new { color: #f2f2f2; }
.gs-mark-old { color: #6a6a6a; }
.gs-absent { display: inline-block; border: 1px dashed #3a3a3a; border-radius: 5px; }
.gs-cell figcaption { text-align: center; display: flex; flex-direction: column; gap: 2px; min-width: 0; width: 100%; }
.gs-cell code { font-size: 10.5px; color: #9a9a9a; font-family: ui-monospace, SFMono-Regular, monospace; overflow-wrap: anywhere; line-height: 1.3; }
.gs-cell small { font-size: 9.5px; color: #5a5a5a; }
.gs-empty { color: #888; font-size: 13px; }
`

export default {
  title: "Foundations/Glyph system",
  parameters: { layout: "fullscreen" },
}

export const Workshop = () => <Workbench />
