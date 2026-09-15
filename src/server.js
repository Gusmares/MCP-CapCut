#!/usr/bin/env node
// capcut-mcp: MCP stdio server exposing CapCut draft-editing tools.
// Editing tools accumulate in an in-memory session (open -> edit -> edit -> save);
// nothing touches disk until capcut_save. All times are in SECONDS at the tool boundary.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { CapCutDraft, cloneDraft, listDrafts, DRAFTS_DIR, FILTERS, TRANSITIONS, MASKS, CAPTION_STYLES, searchCatalog, findInCatalog } from './core.js';

const KEYFRAME_PROPERTIES = ['KFTypePositionX', 'KFTypePositionY', 'KFTypeRotation', 'KFTypeScaleX', 'KFTypeScaleY', 'UNIFORM_SCALE', 'KFTypeAlpha', 'KFTypeSaturation', 'KFTypeContrast', 'KFTypeBrightness', 'KFTypeVolume'];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.join(__dirname, '..');
const CACHE_DIR = path.join(PKG_ROOT, '.transcript-cache');
const WHISPER_PYTHON = process.env.CAPCUT_WHISPER_PYTHON || path.join(PKG_ROOT, 'vendor', 'whisper-env', 'Scripts', 'python.exe');
const WHISPER_SCRIPT = path.join(PKG_ROOT, 'vendor', 'transcribe_local.py');
const PROFILES_DIR = process.env.CAPCUT_PROFILES_DIR || path.join(PKG_ROOT, '..', 'perfis-criativo');

// ---------- transcription helpers ----------
function extractAudio(sourceFile, { preprocess = true } = {}) {
  const out = path.join(CACHE_DIR, `audio-${crypto.randomUUID()}.wav`);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const filters = preprocess ? 'highpass=f=80,lowpass=f=8000,loudnorm' : null;
  const args = ['-y', '-i', sourceFile, '-vn', '-ac', '1', '-ar', '16000'];
  if (filters) args.push('-af', filters);
  args.push(out);
  execFileSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  return out;
}

async function transcribeDeepgram(audioPath, { language = 'pt-BR', vocabularyBoost } = {}) {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) throw new Error('DEEPGRAM_API_KEY is not set. Create a Deepgram account (https://console.deepgram.com), generate an API key, and set it as the DEEPGRAM_API_KEY environment variable for this MCP server -- or use provider:"local" instead (no account needed).');
  const params = new URLSearchParams({ model: 'nova-3', language, smart_format: 'true', punctuate: 'true' });
  if (vocabularyBoost?.length) params.set('keyterm', vocabularyBoost.join(','));
  const audioBuf = fs.readFileSync(audioPath);
  const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: 'POST',
    headers: { Authorization: `Token ${key}`, 'Content-Type': 'audio/wav' },
    body: audioBuf,
  });
  if (!res.ok) throw new Error(`Deepgram API error ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const alt = json?.results?.channels?.[0]?.alternatives?.[0];
  const words = (alt?.words || []).map(w => ({ word: (w.punctuated_word || w.word).trim(), startUs: Math.round(w.start * US), endUs: Math.round(w.end * US), confidence: w.confidence }));
  return { words, language: json?.results?.channels?.[0]?.detected_language || language, durationSec: json?.metadata?.duration };
}

function transcribeLocal(audioPath, { language = 'pt' } = {}) {
  if (!fs.existsSync(WHISPER_PYTHON)) throw new Error(`local transcription venv not found at ${WHISPER_PYTHON}. Run: python -m venv vendor/whisper-env, then pip install -r vendor/requirements-whisper.txt --extra-index-url https://download.pytorch.org/whl/cu126 (see that file's header for details and a CPU-only alternative).`);
  const langCode = language.split('-')[0]; // whisper wants ISO 639-1 ("pt"), not "pt-BR"
  const out = execFileSync(WHISPER_PYTHON, [WHISPER_SCRIPT, audioPath, '--language', langCode], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
  const lastLine = out.trim().split('\n').pop(); // ignore any stderr-ish progress lines that leaked to stdout
  const parsed = JSON.parse(lastLine);
  return { words: parsed.words.map(w => ({ word: w.word, startUs: Math.round(w.start * US), endUs: Math.round(w.end * US), confidence: w.confidence })), language: parsed.language, durationSec: parsed.durationSec, aligned: parsed.aligned, device: parsed.device };
}

function readClientAccentColor(cliente) {
  const p = path.join(PROFILES_DIR, `${cliente}.md`);
  if (!fs.existsSync(p)) return null;
  const text = fs.readFileSync(p, 'utf8');
  const rows = text.split('\n').filter(l => l.trim().startsWith('|') && /#[0-9a-fA-F]{6}/.test(l));
  const ctaRow = rows.find(l => /cta|destaque/i.test(l));
  const hexMatch = (ctaRow || rows[0] || '').match(/#[0-9a-fA-F]{6}/);
  return hexMatch ? hexMatch[0] : null;
}

const US = 1e6;
const open = new Map();                       // name -> live CapCutDraft (unsaved edits)
const get = name => { if (!open.has(name)) open.set(name, new CapCutDraft(name)); return open.get(name); };
const ok = obj => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const err = e => ({ content: [{ type: 'text', text: 'ERROR: ' + (e && e.message || e) }], isError: true });
const wrap = fn => async (a) => { try { return ok(await fn(a)); } catch (e) { return err(e); } };
const sec = v => v == null ? undefined : Math.round(v * US);

// media-placement option shape shared by add_video/image/audio
const placeOpts = {
  atSec: z.number().optional().describe('start time on the timeline, seconds. Omit to append right after the last clip on the target track (no manual running-total math needed).'),
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

s.tool('capcut_list_caption_styles', `List the ${CAPTION_STYLES.length} caption style presets (by business niche): color, chunking, whether it does word-by-word karaoke highlighting, entrance animation.`,
  { query: z.string().optional() },
  wrap(async ({ query }) => ({ total: CAPTION_STYLES.length, styles: (query ? CAPTION_STYLES.filter(s => s.name.toLowerCase().includes(query.toLowerCase()) || s.key.includes(query.toLowerCase())) : CAPTION_STYLES).map(s => ({ key: s.key, name: s.name, karaoke: s.karaoke, localOnly: !!s.localOnly, color: s.color, highlightColor: s.highlightColor })) })));

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
  { draft: z.string(), text: z.string(), atSec: z.number().optional().describe('omit to append right after the last text on the target track'), durSec: z.number().optional(),
    fontSize: z.number().optional(), color: z.string().optional().describe('hex e.g. #ffffff'),
    posX: z.number().optional(), posY: z.number().optional(), trackIndex: z.number().int().optional() },
  wrap(async (a) => get(a.draft).addText(a.text, { atUs: sec(a.atSec), durUs: sec(a.durSec), fontSize: a.fontSize, color: a.color, posX: a.posX, posY: a.posY, trackIndex: a.trackIndex })));

s.tool('capcut_add_track', 'Add a new track (video | audio | text | sticker).',
  { draft: z.string(), type: z.enum(['video', 'audio', 'text', 'sticker']).optional(), name: z.string().optional() },
  wrap(async ({ draft, type, name }) => ({ trackIndex: get(draft).addTrack(type || 'video', name) })));

s.tool('capcut_set_track_mute', 'Mute/unmute an entire track. A track cloned from a muted template starts muted with no visible sign of it in capcut_read_timeline other than the "muted" field -- this is the fix for "the video has no sound" when the clips themselves have audio.',
  { draft: z.string(), trackIndex: z.number().int(), muted: z.boolean() },
  wrap(async ({ draft, trackIndex, muted }) => get(draft).setTrackMute(trackIndex, muted)));

s.tool('capcut_move_segment', 'Move a segment to a new start time and optionally another track.',
  { draft: z.string(), segmentId: z.string(), atSec: z.number(), trackIndex: z.number().int().optional() },
  wrap(async ({ draft, segmentId, atSec, trackIndex }) => get(draft).moveSegment(segmentId, sec(atSec), trackIndex)));

s.tool('capcut_trim_segment', 'Change a segment start / duration / source in-point (seconds). With ripple:true, every later segment (on this track, or every track if rippleAllTracks:true) shifts by the resulting time change instead of leaving a gap or an overlap.',
  { draft: z.string(), segmentId: z.string(), atSec: z.number().optional(), durSec: z.number().optional(), srcStartSec: z.number().optional(),
    ripple: z.boolean().optional(), rippleAllTracks: z.boolean().optional() },
  wrap(async ({ draft, segmentId, atSec, durSec, srcStartSec, ripple, rippleAllTracks }) => get(draft).trimSegment(segmentId, { atUs: sec(atSec), durUs: sec(durSec), srcStartUs: sec(srcStartSec), ripple, rippleAllTracks })));

s.tool('capcut_split_segment', 'Split a segment into two at a timeline time.',
  { draft: z.string(), segmentId: z.string(), atSec: z.number() },
  wrap(async ({ draft, segmentId, atSec }) => get(draft).splitSegment(segmentId, sec(atSec))));

s.tool('capcut_delete_segment', 'Remove a segment. With ripple:true, every later segment (on this track, or every track if rippleAllTracks:true) shifts earlier to close the gap instead of leaving dead space.',
  { draft: z.string(), segmentId: z.string(), ripple: z.boolean().optional(), rippleAllTracks: z.boolean().optional() },
  wrap(async ({ draft, segmentId, ripple, rippleAllTracks }) => get(draft).deleteSegment(segmentId, { ripple, rippleAllTracks })));

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

s.tool('capcut_transcribe', 'Extract audio (ffmpeg) and transcribe it with word-level timestamps, for building auto-captions. provider "deepgram" (default; needs DEEPGRAM_API_KEY, ~US$0.004-0.005/min, pt-BR) or "local" (faster-whisper+WhisperX via a dedicated venv -- no cost, no internet, no account; required by policy for confidential content). Returns a warning instead of failing if no speech is detected.',
  {
    file: z.string().describe('path to the source video/audio file'),
    provider: z.enum(['deepgram', 'local']).optional().describe('default: deepgram. Use "local" for confidential/client-sensitive material.'),
    language: z.string().optional().describe('default "pt-BR" (monolingual); pass "multi" (deepgram only) for heavy pt/en code-switching'),
    vocabularyBoost: z.array(z.string()).optional().describe('brand/product names to bias the ASR toward (deepgram only)'),
    preprocess: z.boolean().optional().describe('default true: loudness normalization + voice bandpass filter before transcription'),
    cacheAs: z.string().optional().describe('save the transcript under this name for capcut_review_transcript / capcut_add_captions to reuse'),
  },
  wrap(async ({ file, provider, language, vocabularyBoost, preprocess, cacheAs }) => {
    if (!fs.existsSync(file)) throw new Error(`file not found: ${file}`);
    const audioPath = extractAudio(file, { preprocess: preprocess !== false });
    try {
      const result = provider === 'local'
        ? transcribeLocal(audioPath, { language: language || 'pt' })
        : await transcribeDeepgram(audioPath, { language: language || 'pt-BR', vocabularyBoost });
      const out = { ...result, provider: provider || 'deepgram', wordCount: result.words.length };
      if (!result.words.length) out.warning = 'no speech detected in this file -- check the source has audible dialogue, or try preprocess:false if the voice filter may be cutting it out';
      if (cacheAs) { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(path.join(CACHE_DIR, `${cacheAs}.json`), JSON.stringify(out)); out.cachedAs = cacheAs; }
      return out;
    } finally {
      try { fs.unlinkSync(audioPath); } catch {}
    }
  }));

s.tool('capcut_review_transcript', 'List transcript words below a confidence threshold, for a quick human check before applying a caption style.',
  { cachedTranscript: z.string(), minConfidence: z.number().optional().describe('default 0.6') },
  wrap(async ({ cachedTranscript, minConfidence }) => {
    const p = path.join(CACHE_DIR, `${cachedTranscript}.json`);
    if (!fs.existsSync(p)) throw new Error(`no cached transcript named "${cachedTranscript}" (run capcut_transcribe with cacheAs:"${cachedTranscript}" first)`);
    const t = JSON.parse(fs.readFileSync(p, 'utf8'));
    const threshold = minConfidence ?? 0.6;
    const flagged = t.words.map((w, i) => ({ ...w, i })).filter(w => (w.confidence ?? 1) < threshold)
      .map(w => ({ word: w.word, startSec: w.startUs / US, endSec: w.endUs / US, confidence: w.confidence, contextBefore: t.words.slice(Math.max(0, w.i - 3), w.i).map(x => x.word).join(' '), contextAfter: t.words.slice(w.i + 1, w.i + 4).map(x => x.word).join(' ') }));
    const avgConfidence = t.words.length ? t.words.reduce((n, w) => n + (w.confidence ?? 1), 0) / t.words.length : null;
    return { wordCount: t.words.length, avgConfidence, flaggedCount: flagged.length, flagged };
  }));

s.tool('capcut_add_captions', 'Generate caption segments in a draft from a transcript, applying a style preset (from capcut_list_caption_styles). Words must already be in the target language/order -- run capcut_transcribe (and ideally capcut_review_transcript) first.',
  {
    draft: z.string(),
    words: z.array(z.object({ word: z.string(), startSec: z.number(), endSec: z.number(), confidence: z.number().optional() })).optional().describe('inline transcript; omit if using cachedTranscript'),
    cachedTranscript: z.string().optional().describe('name saved by capcut_transcribe\'s cacheAs'),
    style: z.string().describe('caption style preset name, from capcut_list_caption_styles'),
    cliente: z.string().optional().describe('client name in perfis-criativo/{cliente}.md -- auto-resolves an accent color override from that profile\'s palette if accentColorOverride is not also given'),
    trackIndex: z.number().int().optional().describe('reuse an existing text track; a new "Captions" track is created if omitted'),
    replace: z.boolean().optional().describe('default false: if true and trackIndex is given, clears that track before regenerating'),
    previewCues: z.number().int().optional().describe('materialize only the first N cues, to check the style in CapCut before committing the whole video'),
    accentColorOverride: z.string().optional().describe('hex color overriding the style\'s own accent/highlight color; takes precedence over "cliente"'),
  },
  wrap(async ({ draft, words, cachedTranscript, style, cliente, trackIndex, replace, previewCues, accentColorOverride }) => {
    let wordList = words;
    if (!wordList) {
      if (!cachedTranscript) throw new Error('provide either "words" or "cachedTranscript"');
      const p = path.join(CACHE_DIR, `${cachedTranscript}.json`);
      if (!fs.existsSync(p)) throw new Error(`no cached transcript named "${cachedTranscript}"`);
      const t = JSON.parse(fs.readFileSync(p, 'utf8'));
      wordList = t.words.map(w => ({ word: w.word, startSec: w.startUs / US, endSec: w.endUs / US, confidence: w.confidence }));
    }
    if (!wordList.length) throw new Error('the transcript has no words -- nothing to caption');
    const wordsUs = wordList.map(w => ({ word: w.word, startUs: Math.round(w.startSec * US), endUs: Math.round(w.endSec * US), confidence: w.confidence }));
    const styleEntry = findInCatalog(CAPTION_STYLES, style);
    if (!styleEntry) throw new Error(`unknown caption style: "${style}" (use capcut_list_caption_styles)`);
    let colorOverride = accentColorOverride;
    if (!colorOverride && cliente) colorOverride = readClientAccentColor(cliente);
    const effectiveStyle = colorOverride ? { ...styleEntry, highlightColor: colorOverride, color: styleEntry.highlightColor ? styleEntry.color : colorOverride } : styleEntry;
    const d = get(draft);
    if (replace && trackIndex != null) d.clearCaptionTrack(trackIndex);
    return d.addCaptions(wordsUs, effectiveStyle, { trackIndex, previewCues });
  }));

s.tool('capcut_clear_captions', 'Remove all segments from a caption track (to switch styles or start over).',
  { draft: z.string(), trackIndex: z.number().int() },
  wrap(async ({ draft, trackIndex }) => get(draft).clearCaptionTrack(trackIndex)));

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
