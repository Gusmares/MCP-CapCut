#!/usr/bin/env node
// capcut-mcp: MCP stdio server exposing CapCut draft-editing tools.
// Editing tools accumulate in an in-memory session (open -> edit -> edit -> save);
// nothing touches disk until capcut_save. All times are in SECONDS at the tool boundary.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { CapCutDraft, cloneDraft, listDrafts, DRAFTS_DIR, FILTERS, TRANSITIONS, MASKS, searchCatalog } from './core.js';

const KEYFRAME_PROPERTIES = ['KFTypePositionX', 'KFTypePositionY', 'KFTypeRotation', 'KFTypeScaleX', 'KFTypeScaleY', 'UNIFORM_SCALE', 'KFTypeAlpha', 'KFTypeSaturation', 'KFTypeContrast', 'KFTypeBrightness', 'KFTypeVolume'];

const US = 1e6;
const open = new Map();                       // name -> live CapCutDraft (unsaved edits)
const get = name => { if (!open.has(name)) open.set(name, new CapCutDraft(name)); return open.get(name); };
const ok = obj => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const err = e => ({ content: [{ type: 'text', text: 'ERROR: ' + (e && e.message || e) }], isError: true });
const wrap = fn => async (a) => { try { return ok(await fn(a)); } catch (e) { return err(e); } };
const sec = v => v == null ? undefined : Math.round(v * US);

// media-placement option shape shared by add_video/image/audio
const placeOpts = {
  atSec: z.number().describe('start time on the timeline, seconds'),
  durSec: z.number().optional().describe('duration (default: full media length)'),
  srcStartSec: z.number().optional().describe('in-point inside the source file, seconds'),
  trackIndex: z.number().int().optional().describe('target track (index in the tracks list); a new track is made if omitted'),
  trackRenderIndex: z.number().int().optional().describe('layer order; higher = on top'),
  scale: z.number().optional(), posX: z.number().optional(), posY: z.number().optional(),
  rotation: z.number().optional(), opacity: z.number().optional(), volume: z.number().optional(), speed: z.number().optional(),
};
const optsFrom = a => ({ atUs: sec(a.atSec), durUs: sec(a.durSec), srcStartUs: sec(a.srcStartSec),
  trackIndex: a.trackIndex, trackRenderIndex: a.trackRenderIndex, scale: a.scale, posX: a.posX, posY: a.posY,
  rotation: a.rotation, opacity: a.opacity, volume: a.volume, speed: a.speed });

const s = new McpServer({ name: 'capcut', version: '0.1.0' });

s.tool('capcut_list_drafts', `List CapCut drafts in ${DRAFTS_DIR} with duration and lock status.`, {}, wrap(async () => ({ draftsDir: DRAFTS_DIR, drafts: listDrafts() })));

s.tool('capcut_list_filters', `Search the bundled catalog of ${FILTERS.length} real CapCut filters by name (case/space-insensitive substring). Omit query to see the first matches.`,
  { query: z.string().optional() }, wrap(async ({ query }) => ({ total: FILTERS.length, matches: searchCatalog(FILTERS, query) })));

s.tool('capcut_list_transitions', `Search the bundled catalog of ${TRANSITIONS.length} real CapCut transitions by name (case/space-insensitive substring). Omit query to see the first matches.`,
  { query: z.string().optional() }, wrap(async ({ query }) => ({ total: TRANSITIONS.length, matches: searchCatalog(TRANSITIONS, query) })));

s.tool('capcut_list_masks', `List the ${MASKS.length} available mask shapes.`, {}, wrap(async () => ({ masks: MASKS.map(m => m.name) })));

s.tool('capcut_read_timeline', 'Read a draft: canvas, fps, tracks and every segment (id, media, times, layer). Reflects any pending unsaved edits from this session.',
  { draft: z.string() }, wrap(async ({ draft }) => get(draft).timeline()));

s.tool('capcut_clone_draft', 'Copy a draft folder to a new name (valid scaffolding). empty:true clears all clips/tracks for a fresh build.',
  { base: z.string(), newName: z.string(), empty: z.boolean().optional() },
  wrap(async ({ base, newName, empty }) => cloneDraft(base, newName, { empty: !!empty })));

s.tool('capcut_add_video', 'Add a video clip at a time on a track. Session edit; call capcut_save to persist.',
  { draft: z.string(), file: z.string(), ...placeOpts },
  wrap(async (a) => get(a.draft).addVideo(a.file, optsFrom(a))));

s.tool('capcut_add_image', 'Add an image at a time on a track.',
  { draft: z.string(), file: z.string(), ...placeOpts },
  wrap(async (a) => get(a.draft).addImage(a.file, optsFrom(a))));

s.tool('capcut_add_audio', 'Add an audio clip at a time on a track.',
  { draft: z.string(), file: z.string(), ...placeOpts },
  wrap(async (a) => get(a.draft).addAudio(a.file, optsFrom(a))));

s.tool('capcut_add_text', 'Add a text overlay. Requires a text template (a draft with a text layer; see CAPCUT_TEMPLATE_DRAFT).',
  { draft: z.string(), text: z.string(), atSec: z.number(), durSec: z.number().optional(),
    fontSize: z.number().optional(), color: z.string().optional().describe('hex e.g. #ffffff'),
    posX: z.number().optional(), posY: z.number().optional(), trackIndex: z.number().int().optional() },
  wrap(async (a) => get(a.draft).addText(a.text, { atUs: sec(a.atSec), durUs: sec(a.durSec), fontSize: a.fontSize, color: a.color, posX: a.posX, posY: a.posY, trackIndex: a.trackIndex })));

s.tool('capcut_add_track', 'Add a new track (video | audio | text | sticker).',
  { draft: z.string(), type: z.enum(['video', 'audio', 'text', 'sticker']).optional(), name: z.string().optional() },
  wrap(async ({ draft, type, name }) => ({ trackIndex: get(draft).addTrack(type || 'video', name) })));

s.tool('capcut_move_segment', 'Move a segment to a new start time and optionally another track.',
  { draft: z.string(), segmentId: z.string(), atSec: z.number(), trackIndex: z.number().int().optional() },
  wrap(async ({ draft, segmentId, atSec, trackIndex }) => get(draft).moveSegment(segmentId, sec(atSec), trackIndex)));

s.tool('capcut_trim_segment', 'Change a segment start / duration / source in-point (seconds).',
  { draft: z.string(), segmentId: z.string(), atSec: z.number().optional(), durSec: z.number().optional(), srcStartSec: z.number().optional() },
  wrap(async ({ draft, segmentId, atSec, durSec, srcStartSec }) => get(draft).trimSegment(segmentId, { atUs: sec(atSec), durUs: sec(durSec), srcStartUs: sec(srcStartSec) })));

s.tool('capcut_split_segment', 'Split a segment into two at a timeline time.',
  { draft: z.string(), segmentId: z.string(), atSec: z.number() },
  wrap(async ({ draft, segmentId, atSec }) => get(draft).splitSegment(segmentId, sec(atSec))));

s.tool('capcut_delete_segment', 'Remove a segment.',
  { draft: z.string(), segmentId: z.string() }, wrap(async ({ draft, segmentId }) => get(draft).deleteSegment(segmentId)));

s.tool('capcut_set_props', 'Set transform / opacity / volume / speed / visibility on a segment.',
  { draft: z.string(), segmentId: z.string(), scale: z.number().optional(), scaleX: z.number().optional(), scaleY: z.number().optional(),
    posX: z.number().optional(), posY: z.number().optional(), rotation: z.number().optional(), opacity: z.number().optional(),
    volume: z.number().optional(), speed: z.number().optional(), visible: z.boolean().optional() },
  wrap(async (a) => get(a.draft).setProps(a.segmentId, a)));

s.tool('capcut_add_filter', 'Attach a real CapCut filter (from capcut_list_filters) to a segment, replacing any filter already on it. intensity is 0-1 (default: the filter\'s own default).',
  { draft: z.string(), segmentId: z.string(), name: z.string(), intensity: z.number().min(0).max(1).optional() },
  wrap(async ({ draft, segmentId, name, intensity }) => get(draft).addFilter(segmentId, name, intensity)));

s.tool('capcut_add_transition', 'Attach a real CapCut transition (from capcut_list_transitions) on this segment, applied between it and whichever segment follows immediately on the same track.',
  { draft: z.string(), segmentId: z.string(), name: z.string(), durationSec: z.number().optional().describe('default: the transition\'s own default duration') },
  wrap(async ({ draft, segmentId, name, durationSec }) => get(draft).addTransition(segmentId, name, sec(durationSec))));

s.tool('capcut_add_mask', 'Attach a mask shape (from capcut_list_masks) to a segment, replacing any mask already on it. center/width/height/rotation/feather/roundCorner are fractions (0-1) unless noted.',
  { draft: z.string(), segmentId: z.string(), name: z.string(), centerX: z.number().optional(), centerY: z.number().optional(),
    width: z.number().optional(), height: z.number().optional(), rotation: z.number().optional(),
    feather: z.number().min(0).max(1).optional(), roundCorner: z.number().min(0).max(1).optional(), invert: z.boolean().optional() },
  wrap(async ({ draft, segmentId, name, ...opts }) => get(draft).addMask(segmentId, name, opts)));

s.tool('capcut_add_keyframe', `Add/replace a keyframe on a segment property at a time, creating real per-property animation (not a static value). Call twice with different atSec/value on the same property to animate between them. property must be one of: ${KEYFRAME_PROPERTIES.join(', ')}.`,
  { draft: z.string(), segmentId: z.string(), property: z.enum(KEYFRAME_PROPERTIES), atSec: z.number(), value: z.number() },
  wrap(async ({ draft, segmentId, property, atSec, value }) => get(draft).addKeyframe(segmentId, property, sec(atSec), value)));

s.tool('capcut_remove_keyframes', 'Remove all keyframes for one property on a segment (it reverts to a static value from clip/set_props).',
  { draft: z.string(), segmentId: z.string(), property: z.enum(KEYFRAME_PROPERTIES) },
  wrap(async ({ draft, segmentId, property }) => get(draft).removeKeyframes(segmentId, property)));

s.tool('capcut_add_audio_fade', 'Set fade-in/fade-out duration on an audio (or audio-carrying) segment. Omit either to leave it unchanged.',
  { draft: z.string(), segmentId: z.string(), fadeInSec: z.number().optional(), fadeOutSec: z.number().optional() },
  wrap(async ({ draft, segmentId, fadeInSec, fadeOutSec }) => get(draft).addAudioFade(segmentId, { fadeInUs: sec(fadeInSec), fadeOutUs: sec(fadeOutSec) })));

s.tool('capcut_add_sticker', 'Add a sticker by CapCut resource_id (get one by inspecting a draft where you or the user already placed that sticker once -- there is no bundled sticker catalog, CapCut\'s sticker library is too large/volatile to ship). Placed on a new or existing sticker track.',
  { draft: z.string(), resourceId: z.string(), ...placeOpts },
  wrap(async ({ draft, resourceId, ...a }) => get(draft).addSticker(resourceId, optsFrom(a))));

s.tool('capcut_undo', 'Undo the last edit in this session (up to 20 steps back). Does not affect anything already saved to disk.',
  { draft: z.string() }, wrap(async ({ draft }) => get(draft).undo()));

s.tool('capcut_raw_patch', 'Advanced escape hatch: deep-merge a JSON patch into draft_content (undocumented ops). Use with care.',
  { draft: z.string(), patch: z.record(z.any()) }, wrap(async ({ draft, patch }) => get(draft).rawPatch(patch)));

s.tool('capcut_validate', 'Check the (in-session) draft for overlaps, duplicate ids/render_index, missing media.',
  { draft: z.string() }, wrap(async ({ draft }) => get(draft).validate()));

s.tool('capcut_save', 'Write session edits to disk (backs up .mcpbak, validates). Refuses if CapCut is open unless force:true.',
  { draft: z.string(), force: z.boolean().optional() },
  wrap(async ({ draft, force }) => { const r = get(draft).save({ force: !!force }); open.delete(draft); return r; }));

s.tool('capcut_discard', 'Drop unsaved session edits and reload the draft from disk.',
  { draft: z.string() }, wrap(async ({ draft }) => { open.delete(draft); return { discarded: draft }; }));

const transport = new StdioServerTransport();
await s.connect(transport);
process.stderr.write(`[capcut-mcp] ready. drafts: ${DRAFTS_DIR}\n`);
