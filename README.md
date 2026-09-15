# capcut-mcp (fork)

An MCP server that lets Claude **read and edit CapCut desktop draft projects** — add/move/trim/split clips, text, audio, images; filters, transitions, masks, keyframe animation, audio fades, stickers; set transforms; validate; save; undo. It works by cloning real segment/material templates out of an existing draft (the only reliable way to produce valid CapCut JSON) plus a bundled catalog of real CapCut filter/transition/mask resource IDs (see [Bundled effect catalog](#bundled-effect-catalog)), and it saves atomically with a backup and a validation pass.

> This is a fork of [JmsLdrn/capcut-mcp](https://github.com/JmsLdrn/capcut-mcp) by [James Aldrin Boncales](https://jmsldrn.com), maintained here with security fixes and capability additions (see commit history). Still **free & open source (MIT)** — original copyright retained in [LICENSE](LICENSE).
>
> **Not affiliated with CapCut or ByteDance.** CapCut's draft format is proprietary and undocumented; this tool reads/writes it defensively (clone-from-template, backups, validation), but a CapCut update can shift the schema. **Keep the backups it makes.**

## Requirements
- **Node 18+**
- **ffmpeg/ffprobe** on PATH (used to read media duration/resolution)
- **CapCut desktop** (Windows layout assumed; macOS path is auto-detected too)

## Configure (env, optional)
- `CAPCUT_DRAFTS_DIR` — your CapCut Drafts folder. Auto-detects the standard `%LOCALAPPDATA%\CapCut\...` (Windows) / `~/Movies/CapCut/...` (macOS) locations; **set this if your drafts live elsewhere** (e.g. a different drive).
- `CAPCUT_TEMPLATE_DRAFT` — name of a draft that contains video **and text** layers, used to harvest templates when the draft you're editing lacks one. **Default `0723` is the author's own draft and won't exist on your machine** — set this to one of *your* drafts that has a text layer, or the `capcut_add_text` tool won't work. (Everything else works without it.)

## Install
```bash
git clone https://github.com/JmsLdrn/capcut-mcp
cd capcut-mcp
npm install
```
Then register it in Claude Code — **use the absolute path to `src/server.js` on your machine**:
```bash
claude mcp add capcut --scope user -- node "/ABSOLUTE/PATH/TO/capcut-mcp/src/server.js"
```
…or add a project-scoped `.mcp.json` at your repo root (copy `mcp.json.example` and edit the paths):
```json
{
  "mcpServers": {
    "capcut": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/capcut-mcp/src/server.js"],
      "env": { "CAPCUT_DRAFTS_DIR": "", "CAPCUT_TEMPLATE_DRAFT": "" }
    }
  }
}
```
Leave the `env` values blank to auto-detect, or fill them in (see **Configure** above). Restart Claude Code; the tools then appear as `mcp__capcut__*`.

## Workflow (important)
1. **Close CapCut** on the draft you want to edit. CapCut autosaves on a timer; writing while it's open gets clobbered. `capcut_save` refuses if CapCut is running or the draft's `.locked` file is present (override with `force: true` only if you know it's safe).
2. Edits are a **session**: `capcut_add_*` / `capcut_move_*` etc. accumulate in memory. Nothing hits disk until **`capcut_save`**.
3. `capcut_save` writes `draft_content.json` (+ meta) **atomically** after making a `.mcpbak` backup, and runs `capcut_validate`.
4. Reopen the draft in CapCut.

All times at the tool boundary are in **seconds** (converted to CapCut's microseconds internally).

## Tools
| Tool | Purpose |
|---|---|
| `capcut_list_drafts` | list drafts + duration + lock status |
| `capcut_read_timeline` | full read: canvas, fps, tracks, every segment (reflects pending session edits) |
| `capcut_clone_draft` | copy a draft (optionally emptied) for a fresh build |
| `capcut_add_video / _image / _audio` | place media on a track. Omit `atSec` to append right after the last clip on that track — no running-total math needed for a sequence of clips |
| `capcut_add_text` | text overlay (needs a text template draft). Omit `atSec` to append too |
| `capcut_add_track` | new video/audio/text/sticker track |
| `capcut_set_track_mute` | mute/unmute an entire track — a track cloned from a muted template starts muted with no visible sign of it besides this field |
| `capcut_move_segment` | change start time / track |
| `capcut_trim_segment` | change start / duration / source in-point. `ripple:true` shifts every later segment by the resulting time change instead of leaving a gap or overlap (`rippleAllTracks:true` to shift every track, not just this one) |
| `capcut_split_segment` | split at a time |
| `capcut_delete_segment` | remove. `ripple:true` shifts later segments earlier to close the gap (`rippleAllTracks:true` for every track) |
| `capcut_set_props` | scale / position / rotation / opacity / volume / speed / visibility (static value for the whole segment) |
| `capcut_list_filters` / `capcut_list_transitions` / `capcut_list_masks` | search the bundled real-CapCut catalog by name |
| `capcut_add_filter` | attach a real filter (from the catalog) to a segment, with optional intensity |
| `capcut_add_transition` | attach a real transition on a segment, applied to whatever follows it on the same track |
| `capcut_add_mask` | attach a mask shape (circle/rectangle/heart/star/linear/mirror) with position/size/feather/rounding |
| `capcut_add_keyframe` / `capcut_remove_keyframes` | real per-property animation over time (position/scale/rotation/alpha/saturation/contrast/brightness/volume) — not just a static value. `atSec` is absolute timeline time like every other tool here; internally converted to CapCut's segment-relative `time_offset`, and rejected with a clear error if it falls outside the segment's own span |
| `capcut_add_audio_fade` | fade-in/fade-out duration on an audio segment |
| `capcut_add_sticker` | place a sticker by CapCut `resource_id` (no bundled sticker catalog — see Limitations) |
| `capcut_undo` | step back up to 20 in-session edits (does not touch anything already saved) |
| `capcut_raw_patch` | advanced deep-merge escape hatch for anything not covered above |
| `capcut_validate` | overlaps, duplicate ids, missing media — **now enforced by `capcut_save`**, not just informational |
| `capcut_save` / `capcut_discard` | persist / drop the session |

`capcut_save` now refuses to write (unless `force:true`) if `capcut_validate` reports issues, or if the draft changed on disk since this session loaded it (e.g. you edited it in CapCut in the meantime).

## Companion skill
A Claude **skill** ships in [`skills/capcut-reels/`](skills/capcut-reels/SKILL.md). It teaches Claude the full production pipeline these tools were built for — record → captions (WhisperFlow) → motion graphics (HyperFrames) → probe/render (ffprobe/ffmpeg) → assemble & caption the CapCut draft via this MCP. Copy the `capcut-reels` folder into your Claude skills directory to install it.

## Bundled effect catalog

Filters, transitions, and masks in real CapCut are **not freely inventable** — CapCut resolves them by a matched `(resource_id, effect_id)` pair from its own asset catalog, not from arbitrary strings. Rather than only being able to reuse whatever effect happened to already be in one of your drafts, this fork bundles a real catalog as data-only JSON (`src/metadata/*.json`), extracted from Python source in [sun-guannan/VectCutAPI](https://github.com/sun-guannan/VectCutAPI) (which vendors [GuanYixuan/pyJianYingDraft](https://github.com/GuanYixuan/pyJianYingDraft)) — both **Apache License 2.0**. Full provenance and license text pointer in [`src/metadata/NOTICE.md`](src/metadata/NOTICE.md).

- **474 filters** (`capcut_list_filters`) — shared JianYing/CapCut catalog; basic filters are believed cross-compatible but this isn't independently confirmed (see NOTICE.md)
- **116 transitions** (`capcut_list_transitions`) — from CapCut's own dedicated catalog, high confidence
- **9 masks**: Circle, Rectangle, Heart, Stars, Text, Split, Filmstrip, Brush, Pen (`capcut_list_masks`) — CapCut-specific, high confidence

**Not yet ported**: the video/character scene-effects catalog (1,000+ entries with per-effect adjustable parameters) and canned intro/outro/loop animations — both exist in the same upstream metadata and could be added the same way, just not done yet. Use `capcut_raw_patch` for those in the meantime.

**Stickers are different**: CapCut's sticker library is too large and changes too often to bundle, so `capcut_add_sticker` takes a raw `resource_id` you obtain by inspecting a draft where that sticker was placed once (by you or the user, in the real app).

**Masks key confirmed against a real draft**: research disagreed on whether masks live under `materials.masks` or `materials.common_mask` — inspecting an actual CapCut 9.4.0 draft settled it: it's `common_mask` (`masks` doesn't exist in a real draft's `materials` at all). `addMask` uses `common_mask`.

## Guardrails
- Won't save while CapCut is open (autosave clobber protection), or if the draft changed on disk since this session loaded it.
- Won't save a draft `capcut_validate` flags as broken (overlaps, duplicate ids, render_index clashes, out-of-range keyframes, dangling material references) unless `force:true`.
- `capcut_read_timeline` shows an explicit `warning` when CapCut is open on the draft you're editing.
- `.mcpbak` backup + atomic temp-then-rename write.
- New drafts are **cloned from a known-good base**, never built from an empty object.
- `capcut_undo` steps back through in-session edits (up to 20), independent of the disk.

## Limitations (be honest with these)
- CapCut's draft format is **proprietary and undocumented**, and changes between CapCut versions. This server is defensive (clone-from-template, backup, validate) but a CapCut update can still shift the schema — keep the backups.
- Filters/transitions/masks are limited to what's in the bundled catalog (see above) — ask for something not in it and `capcut_add_filter`/`_transition`/`_mask` will say so rather than silently failing.
- Video/character scene effects (blur, glitch, etc.) and canned intro/outro animations aren't ported yet — use `capcut_raw_patch`.
- Rich multi-style text (per-word styling, karaoke captions) is still a single uniform style per text block.
- `capcut_add_text` needs a draft with a text layer to harvest from (`CAPCUT_TEMPLATE_DRAFT`).
- No canvas/aspect-ratio retargeting (e.g. 16:9 → 9:16) yet.

## Architecture
- `src/core.js` — pure engine (`CapCutDraft` class + `cloneDraft`/`listDrafts` + the bundled catalog helpers). Testable without MCP.
- `src/server.js` — thin MCP stdio server; declares the tools and calls the core.
- `src/metadata/*.json` — bundled filter/transition/mask catalogs (see [Bundled effect catalog](#bundled-effect-catalog)).

## License & credits
MIT © 2026 [James Aldrin Boncales](https://jmsldrn.com). Contributions and issues welcome. If this saves you time, a link back to [jmsldrn.com](https://jmsldrn.com) is appreciated — not required.

*Always keep a copy of important drafts before batch-editing. This software is provided "as is", without warranty.*
