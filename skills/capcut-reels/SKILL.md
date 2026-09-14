---
name: capcut-reels
description: >-
  Edit and assemble CapCut desktop drafts programmatically with Claude via the
  capcut MCP server, and run the full short-video pipeline behind them: record →
  captions (WhisperFlow) → motion graphics (HyperFrames) → probe/encode
  (ffprobe/ffmpeg) → assemble, trim, split, caption a CapCut draft. Use when the
  user wants to build, edit, re-cut, caption, or reorder a CapCut project (Reels,
  Shorts, TikTok, YouTube, explainers) instead of doing it by hand in the app.
---

# CapCut reels pipeline

This skill drives real CapCut desktop projects through the **capcut MCP** (tools named
`mcp__capcut__*`) plus a small set of companion tools. It is the repeatable process behind a
series of vertical real-estate reels; it generalizes to any short-form video assembled from
clips + captions + motion graphics.

## Prerequisites
- **capcut MCP** installed and connected (`claude mcp add capcut ...`). Tools appear as `mcp__capcut__*`.
- **CapCut desktop** installed, with the drafts you want to edit saved locally.
- **ffmpeg + ffprobe** on PATH (durations/resolutions; final encodes).
- **HyperFrames** (optional) for motion-graphic overlays / full-screen animated scenes.
- **WhisperFlow** (optional) for transcription → captions/subtitles.

## The one rule that matters most
**Close CapCut on the draft before saving.** CapCut autosaves on a timer and will clobber your
edits. `capcut_save` refuses when CapCut is running or the draft's `.locked` file exists — do not
`force` past that unless you are certain the app is closed. All times at the tool boundary are in
**seconds**.

## Workflow

1. **Inspect.** `capcut_list_drafts` to find the draft; `capcut_read_timeline` to see canvas, fps,
   tracks, and every segment (ids, media, start/duration in seconds, layer). Note the segment `id`s
   you'll act on.
2. **Start from a known-good base.** For a fresh build, `capcut_clone_draft` (optionally `empty:true`)
   rather than authoring JSON from scratch — cloning is the only reliable way to get valid CapCut
   structure. To edit in place, just operate on the existing draft.
3. **Prepare media (companion tools, outside CapCut):**
   - Motion graphics / animated scenes → **HyperFrames**, rendered to `.mp4` (or alpha `.mov`).
   - Captions → **WhisperFlow** transcript; convert cue timings to seconds for `capcut_add_text`,
     or burn them in HyperFrames if you want styled/animated captions.
   - Use **ffprobe** to confirm each asset's duration before placing it so timings line up.
4. **Assemble in the draft (session edits accumulate in memory):**
   - `capcut_add_video` / `_image` / `_audio` — place media at `atSec` on a track.
   - `capcut_add_text` — captions/titles (needs a text-template draft; see `CAPCUT_TEMPLATE_DRAFT`).
   - `capcut_add_track` — separate layers for b-roll, captions, music.
   - `capcut_move_segment` / `_trim_segment` / `_split_segment` / `_delete_segment` — re-cut and retime.
   - `capcut_set_props` — scale, position, rotation, opacity, volume, speed, visibility (static value).
   - `capcut_add_keyframe` / `_remove_keyframes` — real per-property animation (Ken Burns zooms, fades,
     eased moves) instead of a static value; call it twice with different `atSec`/`value` on the same
     `property` to animate between them.
   - `capcut_list_filters` / `_transitions` / `_masks` to search the bundled real-CapCut catalog by
     name, then `capcut_add_filter` / `_transition` / `_mask` to attach one. Only names in that
     catalog work — CapCut resolves effects by a matched resource/effect id, not free text.
   - `capcut_add_audio_fade` — fade-in/out duration on an audio segment.
   - `capcut_add_sticker` — needs a real `resource_id` (harvest one from a draft where it was placed
     once; there's no bundled sticker catalog).
   - `capcut_raw_patch` — escape hatch for anything not covered above (rich text styling, video/
     character scene effects, canned intro/outro animations — not yet ported to the bundled catalog).
5. **Validate, then save.** `capcut_validate` (overlaps, duplicate ids, missing media) → fix anything
   flagged → **close CapCut** → `capcut_save` (now refuses to write if validate() still has issues, or
   if the draft changed on disk since this session loaded it — pass `force:true` only if you mean it).
   Use `capcut_undo` to step back one edit, or `capcut_discard` to drop the whole unsaved session.
6. **Reopen in CapCut** to review, then export from the app (or encode the assembled pieces with ffmpeg).

## Tips & gotchas
- **Seconds in, seconds out.** The MCP converts to CapCut's microseconds internally — never pass µs.
- **Layer order** is `render_index` / `track_render_index`: higher = on top. Captions and overlays go
  above b-roll.
- **Keep the `.mcpbak` backups.** CapCut's format changes between versions; a bad edit is recoverable
  from the backup.
- **`add_text` failing?** The default template draft won't exist on a new machine — set
  `CAPCUT_TEMPLATE_DRAFT` to one of your own drafts that contains a text layer.
- **Narration vs visuals mismatch** is normal when scenes are re-cut faster than the voiceover; keep
  narration on its own audio track and trim/speed it to match.

## What this skill does NOT do
- It doesn't render the final export (do that in CapCut, or with ffmpeg on the assembled clips).
- Effects, transitions, animations, and rich-text styling are **best-effort** via `capcut_raw_patch`.
- It doesn't manage the media files themselves — point tools at real files that exist on disk.
