# Review notes

## Gate A

Stills `gate-a/`. Owner fixes applied: harness and model names as the app spells them;
"Done in 4m 38s" removed from the deploy shot; composer baseline raised to 65% of the
frame with the tile → picker flight as one arc; Taj thinned to 30% near the UI and full
only on the right third; Models opens on the "Claude Code" header and does not scroll;
example repo renamed `your-org/agent-plugins`.

## Gate B

Self-check against the checklist, on `gate-b/` strips and the full contact sheets.

| # | Time | Defect | Evidence | Fix |
|---|---|---|---|---|
| 1 | 6.25–7.0 | Marks flew into empty space and crossed the composer before the picker existed. | `strip-flight.jpg` (first render) | Composer settles from 5.8 s, picker opens at 6.3 s, marks land in an open menu. |
| 2 | 24.4–25.0 | Hand-off left a lone composer on blank paper for ~0.3 s. | `strip-handoff.jpg` | Session window fades in from 24.4 s while the composer travels into its dock. |
| 3 | 26.4–28.0 | Zooming the session slid rail text under the headline; the waking line was 14 px. | `strip-session.jpg` | Headline holds 2.4 s at 1×, leaves, then the camera pushes 1.42× on the waking notice. |

Also fixed: a full-width noise frame at 55.0 s (plate noise now thinned and faded in);
"dev" printed before its command finished typing (every typing run is now checked to end
≥ 0.15 s before the event after it); the 9:16 picker and Taj re-balanced into the middle
third; team headline wrapped into its subline.

Checklist: hook by 1.9 s (caret from frame 0, line typed); cuts on bar lines (12.5, 17.5,
25, 35, 42.5, 50, 55); real assets only; one type family and palette; the last frame is
the poster (`gate-c/film-poster.jpg`).

## Gate C

Finals: `gate-c/` contact sheets and posters for film, social and loop. ffprobe: H.264
High, yuv420p, 60 fps, AAC 48 kHz (film, social), `moov` before `mdat`.

Seekability: a frame rendered directly equals the same frame rendered again on the same
page bit for bit, and the score re-renders bit-identically. A frame reached by seeking vs
by walking the previous 1.5 s matches the picture; Chromium's raster cache can differ in
anti-aliasing by 1–3/255 on edges that just moved (17/255 on a few pixels of one glyph at
9.4 s). Not visible after encoding.

## Still needs a human

- The score is synthesised in plain JS in the page, not by an OfflineAudioContext graph:
  Chromium sums node inputs in a run-dependent order (two WebAudio renders differed by
  ±1 LSB on 770 and 1790 samples). Swap back if bit-exact audio matters less than that.
- Listen to the score on speakers and headphones; it was checked by loudness (−16.4 LUFS
  integrated, −1.5 dBFS peak, sections from −27 to −12 dB), waveform shape and
  bit-identical re-renders, not by ear.
- Product UI text in the wide desktop shots (Models, Marketplace) is 14–15 px at 1×;
  legible on a laptop, small on a phone. The 9:16 cut is the phone deliverable.
- Model names follow the UX-audit screens and fixtures; confirm the ones to feature.
- Marketplace plugin names (release-notes, linear, frontend-design, posthog) come from
  the site's PluginToggles crop.
