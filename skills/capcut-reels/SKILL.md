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
   - Captions → real pipeline now: `capcut_transcribe` (Deepgram by default, or `provider:"local"`
     for no-cost/no-account) → `capcut_review_transcript` for a quick confidence check →
     `capcut_add_captions` with a style from `capcut_list_caption_styles` (or `cliente:"name"` to
     pull that client's accent color from `perfis-criativo/`). See the repo README's "Auto-captions"
     section for setup. Only reach for HyperFrames if you need something a caption preset can't do.
   - Use **ffprobe** to confirm each asset's duration before placing it so timings line up.
4. **Assemble in the draft (session edits accumulate in memory):**
   - `capcut_add_video` / `_image` / `_audio` — place media on a track. **Omit `atSec`** when clips
     play back-to-back — it appends right after the last clip on that track, so you never have to
     sum up durations yourself. Only pass `atSec` for a deliberate gap or overlap.
   - `capcut_add_text` — captions/titles (needs a text-template draft; see `CAPCUT_TEMPLATE_DRAFT`).
     Same append-by-default rule.
   - `capcut_add_track` — separate layers for b-roll, captions, music.
   - `capcut_move_segment` / `_trim_segment` / `_split_segment` / `_delete_segment` — re-cut and retime.
     **Pass `ripple:true`** on trim/delete whenever the edit should behave like a real cut (close the
     gap, push everything after it) rather than leaving dead space — this is almost always what "cut
     the boring part" or "make this clip shorter" means. Add `rippleAllTracks:true` if other tracks
     (music, captions) must stay in sync with the ripple too; leave it off to ripple just one track.
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

## How to plan a multi-step edit

Don't fire tool calls one at a time as they occur to you — a real edit is a short plan, executed in
an order that doesn't fight itself:

1. **Read first.** `capcut_read_timeline` before touching anything, even on a draft you just built —
   it reflects this session's pending edits too, so it's always the source of truth for segment ids
   and current timings.
2. **Cuts before adds, ripple as you go.** If the request mixes removing/shortening footage with
   adding new material ("cut the dead air, then add a caption over the result"), do the cuts first
   with `ripple:true` so later timestamps are already correct when you place the new material —
   otherwise you're computing offsets against a timeline that's about to shift under you.
3. **Sequence additions with append, not arithmetic.** When placing N clips/captions in order, omit
   `atSec` on each one instead of tracking a running total by hand — that's exactly the class of
   mistake (off-by-one timing, drift after an edit) manual math invites.
4. **Batch, then validate once.** Make all the related edits for one request, then run
   `capcut_validate` and read `issues`/`warnings` before `capcut_save` — don't save after every single
   tool call. `capcut_undo` recovers from one bad step without discarding the whole batch.
5. **Re-read after anything surprising.** If a tool result doesn't match your mental model of the
   timeline (wrong duration, unexpected overlap), `capcut_read_timeline` again rather than guessing —
   it's cheap and it's authoritative.

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
