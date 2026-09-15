// capcut-core: read/edit CapCut desktop draft projects by cloning real templates
// out of a base draft (the only reliable way to produce valid CapCut JSON).
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execSync, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// bundled catalogs (real resource_id/effect_id pairs, ported from pyCapCut's metadata --
// see src/metadata/README.md). Effects/filters/transitions/masks are NOT freely inventable:
// CapCut resolves them by a matched (resource_id, effect_id) pair, so only names in these
// catalogs can be added -- anything else must be harvested from a draft the user already has.
const loadCatalog = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'metadata', name), 'utf8'));
export const FILTERS = loadCatalog('filters.json');
export const TRANSITIONS = loadCatalog('transitions.json');
export const MASKS = loadCatalog('masks.json');
export const CAPTION_STYLES = loadCatalog('caption_styles.json');
// strips accents too (normalize+strip combining marks) -- several catalogs (caption styles) have
// Portuguese names like "Imobiliária", and a caller typing "imobiliaria" without the accent, or the
// ASCII-safe `key` field some catalogs carry, should still resolve.
const normName = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[\s_-]/g, '');
export function findInCatalog(catalog, name) {
  const target = normName(name);
  return catalog.find(e => normName(e.name) === target || (e.key && normName(e.key) === target)) || null;
}
export function searchCatalog(catalog, query, limit = 40) {
  const list = query ? catalog.filter(e => normName(e.name).includes(normName(query))) : catalog;
  return list.slice(0, limit).map(e => e.name);
}
// material kinds that represent a creative choice made on ONE specific harvested segment
// (a transition, filter, effect, mask, fade, or canned animation) and must NOT be silently
// cloned onto a brand new, unrelated segment -- these are added explicitly via their own
// tools instead. Verified against a real, unedited CapCut draft: every segment also carries
// ~6 boilerplate default refs (speed, canvas, placeholder info, sound-channel mapping, material
// color, vocal separation, etc.) that a new segment needs too -- those are NOT in this list and
// get cloned as before. An earlier version of this used an allowlist of just 'speeds', which
// silently dropped those boilerplate refs from every new segment; this blocklist fixes that.
const CONTAMINATING_REF_KINDS = new Set(['transitions', 'effects', 'video_effects', 'masks', 'common_mask', 'audio_fades', 'material_animations', 'stickers']);

// ---- where the drafts live (override with CAPCUT_DRAFTS_DIR) ----
const STD_WIN = path.join(os.homedir(), 'AppData/Local/CapCut/User Data/Projects/com.lveditor.draft');
const STD_MAC = path.join(os.homedir(), 'Movies/CapCut/User Data/Projects/com.lveditor.draft');
const CANDIDATES = [
  process.env.CAPCUT_DRAFTS_DIR,
  'D:/Capcut/CapCut Drafts',
  STD_WIN,
  STD_MAC,
].filter(Boolean);
// pick the first candidate that exists; otherwise fall back to the OS-standard CapCut location
export const DRAFTS_DIR =
  CANDIDATES.find(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } })
  || (process.platform === 'win32' ? STD_WIN : STD_MAC);
// a draft known to contain video/text/audio layers, used to harvest templates
const TEMPLATE_DRAFT = process.env.CAPCUT_TEMPLATE_DRAFT || '0723';

// resolve a draft name to a path guaranteed to stay inside DRAFTS_DIR (blocks '..' and absolute-path traversal)
function safeDraftPath(name) {
  if (typeof name !== 'string' || !name) throw new Error(`invalid draft name: ${JSON.stringify(name)}`);
  const base = path.resolve(DRAFTS_DIR);
  const resolved = path.resolve(base, name);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error(`invalid draft name: ${name} (must stay inside ${DRAFTS_DIR})`);
  return resolved;
}

const uid = () => crypto.randomUUID().toUpperCase();
const clone = o => JSON.parse(JSON.stringify(o));
const US = 1e6;

function probeDur(file) {
  try { return Math.round(parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]).toString().trim()) * US); }
  catch { return 5 * US; }
}
function probeWH(file) {
  try { const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file]).toString().trim().split('x').map(Number); return { w: w || 1920, h: h || 1080 }; }
  catch { return { w: 1920, h: 1080 }; }
}

// ---- template harvesting: pull one segment (+its material +extra_material_refs +a track) per type ----
function findMat(content, id) {
  for (const k of Object.keys(content.materials || {})) {
    if (Array.isArray(content.materials[k])) { const m = content.materials[k].find(x => x && x.id === id); if (m) return [k, m]; }
  }
  return [null, null];
}
function harvest(content) {
  const t = { tracks: {} };
  for (const track of content.tracks || []) {
    if (!t.tracks[track.type]) { const tk = clone(track); tk.segments = []; t.tracks[track.type] = tk; }
    for (const seg of (track.segments || [])) {
      const [, mat] = findMat(content, seg.material_id);
      const type = mat && mat.type ? mat.type : track.type;
      if (t[type]) continue;
      if (!mat) continue;
      const refs = (seg.extra_material_refs || []).map(id => { const [k, m] = findMat(content, id); return m ? { k, m: clone(m) } : null; }).filter(Boolean);
      t[type] = { seg: clone(seg), mat: clone(mat), refs };
    }
  }
  return t;
}

export function listDrafts() {
  let names = [];
  try { names = fs.readdirSync(DRAFTS_DIR).filter(n => { try { return fs.statSync(path.join(DRAFTS_DIR, n)).isDirectory() && fs.existsSync(path.join(DRAFTS_DIR, n, 'draft_content.json')); } catch { return false; } }); } catch {}
  return names.map(name => {
    const dir = path.join(DRAFTS_DIR, name);
    let dur = null;
    try { dur = JSON.parse(fs.readFileSync(path.join(dir, 'draft_content.json'), 'utf8')).duration / US; } catch {}
    return { name, locked: fs.existsSync(path.join(dir, '.locked')), durationSec: dur };
  });
}

// is CapCut running? (writing while open gets clobbered by autosave)
function capcutRunning() {
  if (process.platform !== 'win32') return false;
  try { return /CapCut\.exe/i.test(execSync('tasklist /FI "IMAGENAME eq CapCut.exe" /NH', { encoding: 'utf8' })); }
  catch { return false; }
}

export class CapCutDraft {
  constructor(name) {
    this.name = name;
    this.dir = safeDraftPath(name);
    this.contentPath = path.join(this.dir, 'draft_content.json');
    if (!fs.existsSync(this.contentPath)) throw new Error(`draft not found: ${name} (in ${DRAFTS_DIR})`);
    this.content = JSON.parse(fs.readFileSync(this.contentPath, 'utf8'));
    this._loadedMtimeMs = fs.statSync(this.contentPath).mtimeMs;
    this.metaPath = path.join(this.dir, 'draft_meta_info.json');
    this.meta = fs.existsSync(this.metaPath) ? JSON.parse(fs.readFileSync(this.metaPath, 'utf8')) : null;
    this._tpl = null;
  }
  templates() {
    if (this._tpl) return this._tpl;
    let t = harvest(this.content);
    // fill any missing segment type from the template draft
    if (!t.video || !t.text || !t.audio) {
      try { const base = JSON.parse(fs.readFileSync(path.join(DRAFTS_DIR, TEMPLATE_DRAFT, 'draft_content.json'), 'utf8')); const bt = harvest(base);
        for (const k of ['video', 'audio', 'text', 'image']) if (!t[k] && bt[k]) t[k] = bt[k];
        for (const k of Object.keys(bt.tracks)) if (!t.tracks[k]) t.tracks[k] = bt.tracks[k];
      } catch {}
    }
    this._tpl = t; return t;
  }
  _mats(key) { this.content.materials[key] = this.content.materials[key] || []; return this.content.materials[key]; }
  _nextRender() { let m = -1; for (const tr of this.content.tracks) for (const s of (tr.segments || [])) { const ri = s.render_index || 0; if (ri > m) m = ri; } return m + 1; }
  // end time (us) of the last segment on a track, i.e. where the next clip should go to play back-to-back
  _trackEnd(track) { let end = 0; for (const s of (track.segments || [])) end = Math.max(end, s.target_timerange.start + s.target_timerange.duration); return end; }

  // ---------- read ----------
  timeline() {
    const c = this.content;
    const locked = fs.existsSync(path.join(this.dir, '.locked'));
    const running = capcutRunning();
    return {
      name: this.name, durationSec: +(c.duration / US).toFixed(3), fps: c.fps,
      canvas: c.canvas_config && { w: c.canvas_config.width, h: c.canvas_config.height, ratio: c.canvas_config.ratio },
      locked, capcutRunning: running,
      warning: (locked || running) ? '⚠ CapCut is open on this draft -- edits made in the app from now on may conflict with what this session is building. Close it before capcut_save.' : undefined,
      tracks: (c.tracks || []).map((tr, ti) => ({
        index: ti, type: tr.type, name: tr.name, muted: !!tr.attribute, segments: (tr.segments || []).map(s => {
          const [, m] = findMat(c, s.material_id);
          return {
            id: s.id, material: m ? (m.material_name || (m.path || '').split(/[\\/]/).pop() || m.type) : null,
            atSec: +(s.target_timerange.start / US).toFixed(3), durSec: +(s.target_timerange.duration / US).toFixed(3),
            srcStartSec: +((s.source_timerange?.start || 0) / US).toFixed(3), renderIndex: s.render_index, trackRenderIndex: s.track_render_index,
          };
        }),
      })),
    };
  }
  setTrackMute(trackIndexOrId, muted) {
    this._pushUndo();
    const track = typeof trackIndexOrId === 'number' ? this.content.tracks[trackIndexOrId] : this.content.tracks.find(t => t.id === trackIndexOrId);
    if (!track) throw new Error(`no track ${trackIndexOrId}`);
    track.attribute = muted ? 1 : 0;
    return { track: track.name, type: track.type, muted: !!muted };
  }

  // ---------- tracks ----------
  addTrack(type = 'video', name) {
    this._pushUndo();
    const tpl = this.templates().tracks[type] || this.templates().tracks.video;
    if (!tpl) throw new Error(`no track template for type ${type}`);
    const tk = clone(tpl); tk.id = uid(); tk.type = type; tk.segments = []; tk.name = name || `${type} track`; tk.is_default_name = false;
    this.content.tracks.push(tk);
    return this.content.tracks.length - 1;
  }
  _resolveTrack(opts, type) {
    if (opts.trackIndex != null) { const tr = this.content.tracks[opts.trackIndex]; if (!tr) throw new Error(`no track at index ${opts.trackIndex}`); return tr; }
    if (opts.trackId) { const tr = this.content.tracks.find(t => t.id === opts.trackId); if (!tr) throw new Error(`no track ${opts.trackId}`); return tr; }
    let tr = this.content.tracks.find(t => t.type === type); if (tr) return tr;
    return this.content.tracks[this.addTrack(type)];
  }

  // ---------- add media (video/image/audio) ----------
  _addMedia(kind, file, opts) {
    this._pushUndo();
    if (!fs.existsSync(file)) throw new Error(`file not found: ${file}`);
    const type = kind === 'audio' ? 'audio' : (kind === 'image' ? 'photo' : 'video');
    const tplType = kind === 'image' ? (this.templates().image ? 'image' : 'video') : kind;
    const tpl = this.templates()[tplType] || this.templates().video;
    if (!tpl) throw new Error(`no ${kind} template available`);
    const dur = opts.durUs != null ? opts.durUs : probeDur(file);
    const mat = clone(tpl.mat); mat.id = uid(); mat.path = file.replace(/\\/g, '/'); mat.material_name = path.basename(file); mat.type = type;
    if (kind !== 'audio') { const { w, h } = probeWH(file); mat.width = w; mat.height = h; }
    mat.duration = probeDur(file); // always the real file's own duration, never the cloned template's stale value
    ['local_material_id', 'origin_material_id', 'local_id', 'request_id', 'aigc_history_id', 'aigc_item_id'].forEach(k => { if (k in mat) mat[k] = ''; });
    const matKey = kind === 'audio' ? 'audios' : (kind === 'image' ? 'videos' : 'videos'); // CapCut stores images in videos[]
    this._mats(matKey).push(mat);
    const refs = tpl.refs.filter(({ k }) => !CONTAMINATING_REF_KINDS.has(k)).map(({ k, m }) => { const c = clone(m); c.id = uid(); this._mats(k).push(c); return c.id; });
    const seg = clone(tpl.seg); seg.id = uid(); seg.material_id = mat.id; seg.extra_material_refs = refs;
    const track = this._resolveTrack(opts, kind === 'audio' ? 'audio' : 'video');
    const at = opts.atUs != null ? opts.atUs : this._trackEnd(track); // omit atSec to append right after the last clip on this track
    seg.target_timerange = { start: at, duration: dur };
    seg.source_timerange = { start: opts.srcStartUs || 0, duration: dur };
    this._applyProps(seg, opts);
    seg.render_index = this._nextRender();
    seg.track_render_index = opts.trackRenderIndex != null ? opts.trackRenderIndex : (this.content.tracks.indexOf(track));
    track.segments.push(seg);
    this.content.duration = Math.max(this.content.duration || 0, at + dur);
    return { segmentId: seg.id, atSec: at / US, endUs: at + dur };
  }
  addVideo(file, opts = {}) { return this._addMedia('video', file, opts); }
  addImage(file, opts = {}) { return this._addMedia('image', file, opts); }
  addAudio(file, opts = {}) { return this._addMedia('audio', file, opts); }

  // ---------- text ----------
  addText(text, opts = {}) {
    this._pushUndo();
    const tpl = this.templates().text;
    if (!tpl) throw new Error('no text template found. Set CAPCUT_TEMPLATE_DRAFT to a draft that contains a text layer.');
    const mat = clone(tpl.mat); mat.id = uid();
    try {
      const content = JSON.parse(mat.content);
      content.text = text;
      if (content.styles && content.styles[0]) {
        content.styles[0].range = [0, text.length];
        if (opts.color) content.styles[0].fill = { content: { solid: { color: hexToRgb(opts.color) } } };
        if (opts.fontSize) content.styles[0].size = opts.fontSize;
      }
      mat.content = JSON.stringify(content);
    } catch { mat.content = JSON.stringify({ text, styles: [{ range: [0, text.length], size: opts.fontSize || 15, fill: { content: { solid: { color: hexToRgb(opts.color || '#ffffff') } } } }] }); }
    this._mats('texts').push(mat);
    const refs = tpl.refs.filter(({ k }) => !CONTAMINATING_REF_KINDS.has(k)).map(({ k, m }) => { const c = clone(m); c.id = uid(); this._mats(k).push(c); return c.id; });
    const seg = clone(tpl.seg); seg.id = uid(); seg.material_id = mat.id; seg.extra_material_refs = refs;
    const dur = opts.durUs || 3 * US;
    const track = this._resolveTrack(opts, 'text');
    const at = opts.atUs != null ? opts.atUs : this._trackEnd(track); // omit atSec to append right after the last text on this track
    seg.target_timerange = { start: at, duration: dur };
    seg.source_timerange = { start: 0, duration: dur };
    this._applyProps(seg, opts);
    seg.render_index = this._nextRender();
    seg.track_render_index = opts.trackRenderIndex != null ? opts.trackRenderIndex : this.content.tracks.indexOf(track);
    track.segments.push(seg);
    this.content.duration = Math.max(this.content.duration || 0, at + dur);
    return { segmentId: seg.id, atSec: at / US, endUs: at + dur };
  }

  // ---------- edit existing segments ----------
  _find(segId) { for (const tr of this.content.tracks) { const s = (tr.segments || []).find(x => x.id === segId); if (s) return { tr, s }; } throw new Error(`segment not found: ${segId}`); }
  moveSegment(segId, atUs, newTrackIndex) {
    this._pushUndo();
    const { tr, s } = this._find(segId); const dur = s.target_timerange.duration;
    s.target_timerange.start = atUs;
    if (newTrackIndex != null && this.content.tracks[newTrackIndex]) { tr.segments = tr.segments.filter(x => x.id !== segId); this.content.tracks[newTrackIndex].segments.push(s); }
    this._recalcDuration(); return { segmentId: segId, atSec: atUs / US, durSec: dur / US };
  }
  trimSegment(segId, { atUs, durUs, srcStartUs, ripple, rippleAllTracks } = {}) {
    this._pushUndo();
    const { tr, s } = this._find(segId);
    const oldEnd = s.target_timerange.start + s.target_timerange.duration;
    if (atUs != null) s.target_timerange.start = atUs;
    if (durUs != null) { s.target_timerange.duration = durUs; s.source_timerange.duration = durUs; }
    if (srcStartUs != null) s.source_timerange.start = srcStartUs;
    const newEnd = s.target_timerange.start + s.target_timerange.duration;
    const delta = newEnd - oldEnd;
    if (ripple && delta !== 0) this._rippleShift(oldEnd, delta, segId, rippleAllTracks ? this.content.tracks : [tr]);
    this._recalcDuration(); return { segmentId: segId, rippled: !!ripple, shiftedByS: delta / US };
  }
  // shift every segment starting at/after `fromUs` (except `exceptId`) by `deltaUs`, across the given tracks
  _rippleShift(fromUs, deltaUs, exceptId, tracks) {
    for (const t of tracks) for (const seg of (t.segments || [])) {
      if (seg.id === exceptId) continue;
      if (seg.target_timerange.start >= fromUs) seg.target_timerange.start += deltaUs;
    }
  }
  splitSegment(segId, atUs) {
    this._pushUndo();
    const { tr, s } = this._find(segId);
    const t0 = s.target_timerange.start, d = s.target_timerange.duration;
    if (atUs <= t0 || atUs >= t0 + d) throw new Error('split point must be inside the segment');
    const left = atUs - t0;
    const right = clone(s); right.id = uid();
    // clone extra_material_refs so the two halves don't share state
    right.extra_material_refs = (s.extra_material_refs || []).map(id => { const [k, m] = findMat(this.content, id); if (!m) return id; const c = clone(m); c.id = uid(); this._mats(k).push(c); return c.id; });
    s.target_timerange.duration = left; s.source_timerange.duration = left;
    right.target_timerange = { start: atUs, duration: d - left };
    right.source_timerange = { start: (s.source_timerange.start || 0) + left, duration: d - left };
    right.render_index = this._nextRender();
    tr.segments.push(right);
    return { left: segId, right: right.id };
  }
  deleteSegment(segId, { ripple, rippleAllTracks } = {}) {
    this._pushUndo();
    const { tr, s } = this._find(segId);
    const start = s.target_timerange.start, dur = s.target_timerange.duration;
    tr.segments = tr.segments.filter(x => x.id !== segId);
    if (ripple) this._rippleShift(start + dur, -dur, segId, rippleAllTracks ? this.content.tracks : [tr]);
    this._recalcDuration();
    return { deleted: segId, rippled: !!ripple };
  }
  setProps(segId, props = {}) { this._pushUndo(); const { s } = this._find(segId); this._applyProps(s, props); return { segmentId: segId, applied: Object.keys(props) }; }
  _applyProps(seg, p) {
    seg.clip = seg.clip || { alpha: 1, flip: { horizontal: false, vertical: false }, rotation: 0, scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 } };
    if (p.scale != null) { seg.clip.scale = { x: p.scale, y: p.scale }; }
    if (p.scaleX != null) seg.clip.scale.x = p.scaleX;
    if (p.scaleY != null) seg.clip.scale.y = p.scaleY;
    if (p.posX != null) seg.clip.transform.x = p.posX;
    if (p.posY != null) seg.clip.transform.y = p.posY;
    if (p.rotation != null) seg.clip.rotation = p.rotation;
    if (p.opacity != null) seg.clip.alpha = p.opacity;
    if (p.volume != null) seg.volume = p.volume;
    if (p.visible != null) seg.visible = p.visible;
    if (p.speed != null) { seg.speed = p.speed; const spId = (seg.extra_material_refs || []).find(id => findMat(this.content, id)[0] === 'speeds'); if (spId) { const [, sp] = findMat(this.content, spId); if (sp) sp.speed = p.speed; } }
  }
  _recalcDuration() { let max = 0; for (const tr of this.content.tracks) for (const s of (tr.segments || [])) max = Math.max(max, s.target_timerange.start + s.target_timerange.duration); this.content.duration = max; }

  // escape hatch: apply a JSON-merge-style patch to content (advanced/undocumented ops)
  rawPatch(patch) { this._pushUndo(); deepMerge(this.content, patch); return { ok: true }; }

  // ---------- undo (in-memory, per session; not persisted, capped at 20 steps) ----------
  // guarded so a method that calls another _pushUndo-covered method internally (e.g. _addMedia
  // auto-creating a track via addTrack) records ONE snapshot per top-level tool call, not two.
  _pushUndo() {
    if (this._inUndoScope) return;
    this._inUndoScope = true;
    queueMicrotask(() => { this._inUndoScope = false; });
    this._undoStack = this._undoStack || [];
    this._undoStack.push(JSON.stringify(this.content));
    if (this._undoStack.length > 20) this._undoStack.shift();
  }
  undo() {
    if (!this._undoStack || !this._undoStack.length) throw new Error('nothing to undo');
    this.content = JSON.parse(this._undoStack.pop());
    return { ok: true, remaining: this._undoStack.length };
  }

  // ---------- keyframes: real per-property animation over time (common_keyframes) ----------
  addKeyframe(segId, propertyType, atUs, value) {
    this._pushUndo();
    const { s } = this._find(segId);
    // atUs is absolute timeline time, matching every other timing param in this API (moveSegment,
    // trimSegment, addVideo/text/...) -- but CapCut itself stores time_offset relative to the
    // segment's OWN start (confirmed against pyJianYingDraft/VectCutAPI's Keyframe class). Convert
    // here so callers never have to do timeline-minus-segment-start math themselves; a bug that did
    // exactly that (passed absolute time straight through) shipped a keyframe outside the segment's
    // range that CapCut silently never reached.
    const localUs = atUs - s.target_timerange.start;
    const localDur = s.target_timerange.duration;
    if (localUs < 0 || localUs > localDur) throw new Error(`keyframe at ${(atUs / US).toFixed(3)}s is outside this segment's span on the timeline [${(s.target_timerange.start / US).toFixed(3)}s, ${((s.target_timerange.start + localDur) / US).toFixed(3)}s] -- pass an absolute timeline time within the segment, not relative to its start`);
    s.common_keyframes = s.common_keyframes || [];
    let list = s.common_keyframes.find(k => k.property_type === propertyType);
    if (!list) { list = { id: uid(), material_id: '', property_type: propertyType, keyframe_list: [] }; s.common_keyframes.push(list); }
    const entry = { id: uid(), time_offset: localUs, values: [value], curveType: 'Line', graphID: '', left_control: { x: 0, y: 0 }, right_control: { x: 0, y: 0 } };
    const idx = list.keyframe_list.findIndex(k => k.time_offset === localUs);
    if (idx >= 0) list.keyframe_list[idx] = entry; else list.keyframe_list.push(entry);
    list.keyframe_list.sort((a, b) => a.time_offset - b.time_offset);
    // scale_x/scale_y and uniform scale are mutually exclusive in CapCut's model
    s.uniform_scale = s.uniform_scale || { on: true, value: 1 };
    if (propertyType === 'UNIFORM_SCALE') s.uniform_scale.on = true;
    else if (propertyType === 'KFTypeScaleX' || propertyType === 'KFTypeScaleY') s.uniform_scale.on = false;
    return { segmentId: segId, propertyType, keyframeCount: list.keyframe_list.length };
  }
  removeKeyframes(segId, propertyType) {
    this._pushUndo();
    const { s } = this._find(segId);
    const before = (s.common_keyframes || []).length;
    s.common_keyframes = (s.common_keyframes || []).filter(k => k.property_type !== propertyType);
    return { segmentId: segId, removed: before - s.common_keyframes.length };
  }

  // ---------- audio fade (distinct material, not a volume keyframe) ----------
  addAudioFade(segId, { fadeInUs, fadeOutUs } = {}) {
    this._pushUndo();
    const { s } = this._find(segId);
    let fadeId = (s.extra_material_refs || []).find(id => findMat(this.content, id)[0] === 'audio_fades');
    let mat;
    if (fadeId) { [, mat] = findMat(this.content, fadeId); }
    else {
      mat = { id: uid(), type: 'audio_fade', fade_in_duration: 0, fade_out_duration: 0, fade_type: 0 };
      this._mats('audio_fades').push(mat);
      s.extra_material_refs = [...(s.extra_material_refs || []), mat.id];
    }
    if (fadeInUs != null) mat.fade_in_duration = fadeInUs;
    if (fadeOutUs != null) mat.fade_out_duration = fadeOutUs;
    return { segmentId: segId, fadeInSec: mat.fade_in_duration / US, fadeOutSec: mat.fade_out_duration / US };
  }

  // ---------- filters / transitions / masks: real catalog entries only (see FILTERS/TRANSITIONS/MASKS) ----------
  addFilter(segId, name, intensity) {
    this._pushUndo();
    const f = findInCatalog(FILTERS, name);
    if (!f) throw new Error(`unknown filter: "${name}" (use capcut_list_filters to search the bundled catalog)`);
    const { s } = this._find(segId);
    const params = f.params.map((p, i) => ({
      name: p.name, default_value: p.default, min_value: p.min, max_value: p.max,
      value: intensity != null ? p.min + (p.max - p.min) * intensity : p.default,
      parameterIndex: i, portIndex: 0,
    }));
    const mat = {
      id: uid(), type: 'filter', name: f.name, effect_id: f.effectId, resource_id: f.resourceId,
      apply_target_type: 0, value: 1.0, adjust_params: params,
      category_id: '', category_name: '', sub_type: 'none', source_platform: 1, time_range: null,
      algorithm_artifact_path: '', bloom_params: null,
      color_match_info: { source_feature_path: '', target_feature_path: '', target_image_path: '' },
      enable_skin_tone_correction: false, exclusion_group: [], face_adjust_params: [],
      formula_id: '', intensity_key: '', multi_language_current: '', panel_id: '', platform: 'all', version: '',
    };
    this._mats('effects').push(mat);
    // a segment realistically carries one filter at a time -- drop any prior one before attaching the new one
    s.extra_material_refs = (s.extra_material_refs || []).filter(id => { const [k, x] = findMat(this.content, id); return !(k === 'effects' && x && x.type === 'filter'); });
    s.extra_material_refs.push(mat.id);
    return { segmentId: segId, filter: f.name };
  }
  addTransition(segId, name, durationUs) {
    this._pushUndo();
    const t = findInCatalog(TRANSITIONS, name);
    if (!t) throw new Error(`unknown transition: "${name}" (use capcut_list_transitions to search the bundled catalog)`);
    const { s } = this._find(segId);
    const mat = {
      id: uid(), name: t.name, type: 'transition', effect_id: t.effectId, resource_id: t.resourceId,
      duration: durationUs != null ? durationUs : t.defaultDurationUs, is_overlap: t.isOverlap,
      category_id: '', category_name: '', platform: 'all',
    };
    this._mats('transitions').push(mat);
    s.extra_material_refs = (s.extra_material_refs || []).filter(id => findMat(this.content, id)[0] !== 'transitions');
    s.extra_material_refs.push(mat.id);
    return { segmentId: segId, transition: t.name, durationSec: mat.duration / US, note: 'applies between this segment and whatever segment follows it immediately on the same track' };
  }
  addMask(segId, name, opts = {}) {
    this._pushUndo();
    const m = findInCatalog(MASKS, name);
    if (!m) throw new Error(`unknown mask: "${name}" (use capcut_list_masks to see the available shapes)`);
    const { s } = this._find(segId);
    const mat = {
      id: uid(), type: 'mask', name: m.name, resource_type: m.resourceType, resource_id: m.resourceId,
      platform: 'all', position_info: '',
      config: {
        centerX: opts.centerX ?? 0, centerY: opts.centerY ?? 0,
        width: opts.width ?? 0.5, height: opts.height ?? (0.5 * m.defaultAspectRatio),
        aspectRatio: m.defaultAspectRatio, rotation: opts.rotation ?? 0,
        feather: opts.feather ?? 0, invert: !!opts.invert, roundCorner: opts.roundCorner ?? 0,
      },
    };
    this._mats('common_mask').push(mat);
    s.extra_material_refs = (s.extra_material_refs || []).filter(id => findMat(this.content, id)[0] !== 'common_mask');
    s.extra_material_refs.push(mat.id);
    return { segmentId: segId, mask: m.name };
  }

  // ---------- stickers: caller-supplied resource_id -- CapCut resolves geometry from its own catalog ----------
  addSticker(resourceId, opts = {}) {
    this._pushUndo();
    const mat = { id: uid(), type: 'sticker', resource_id: resourceId, sticker_id: resourceId, source_platform: 1 };
    this._mats('stickers').push(mat);
    const dur = opts.durUs || 3 * US;
    const track = this._resolveTrack(opts, 'sticker');
    const at = opts.atUs != null ? opts.atUs : this._trackEnd(track); // omit atSec to append right after the last sticker on this track
    const seg = {
      id: uid(), material_id: mat.id,
      target_timerange: { start: at, duration: dur }, source_timerange: null,
      speed: 1, volume: 1, extra_material_refs: [],
      clip: { alpha: 1, flip: { horizontal: false, vertical: false }, rotation: 0, scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 } },
      uniform_scale: { on: true, value: 1 }, common_keyframes: [], keyframe_refs: [],
      visible: true,
    };
    this._applyProps(seg, opts);
    seg.render_index = this._nextRender();
    seg.track_render_index = opts.trackRenderIndex != null ? opts.trackRenderIndex : this.content.tracks.indexOf(track);
    track.segments.push(seg);
    this.content.duration = Math.max(this.content.duration || 0, at + dur);
    return { segmentId: seg.id, atSec: at / US, endUs: at + dur };
  }

  // ---------- captions ----------
  // builds one text segment from a harvested text template, given fully-formed content (text +
  // styles[]) rather than a single plain string -- shared by addText's simple case and addCaptions'
  // multi-range (karaoke) case.
  _buildCaptionSegment(tpl, text, styles, atUs, durUs, track) {
    const mat = clone(tpl.mat); mat.id = uid();
    let content; try { content = JSON.parse(mat.content); } catch { content = {}; }
    content.text = text; content.styles = styles;
    mat.content = JSON.stringify(content);
    this._mats('texts').push(mat);
    const refs = tpl.refs.filter(({ k }) => !CONTAMINATING_REF_KINDS.has(k)).map(({ k, m }) => { const c = clone(m); c.id = uid(); this._mats(k).push(c); return c.id; });
    const seg = clone(tpl.seg); seg.id = uid(); seg.material_id = mat.id; seg.extra_material_refs = refs;
    seg.target_timerange = { start: atUs, duration: durUs };
    seg.source_timerange = { start: 0, duration: durUs };
    seg.render_index = this._nextRender();
    seg.track_render_index = this.content.tracks.indexOf(track);
    track.segments.push(seg);
    this.content.duration = Math.max(this.content.duration || 0, atUs + durUs);
    return seg;
  }
  // entrance animation for a just-created caption segment, via the real addKeyframe() mechanism --
  // clamped to the segment's own (possibly very short) duration so it never throws.
  _animateCaption(seg, style) {
    const anim = style.animation; if (!anim) return;
    const atUs = seg.target_timerange.start;
    const segEndUs = atUs + seg.target_timerange.duration;
    const endUs = Math.min(atUs + Math.round((anim.durationSec || 0.3) * US), segEndUs);
    if (endUs - atUs < 10000) return; // too short to animate meaningfully (<10ms) -- leave it static
    const kf = (prop, from, to) => { this.addKeyframe(seg.id, prop, atUs, from); this.addKeyframe(seg.id, prop, endUs, to); };
    switch (anim.type) {
      case 'fade': kf('KFTypeAlpha', 0, 1); break;
      case 'fade-rise': kf('KFTypeAlpha', 0, 1); kf('KFTypePositionY', -0.03, 0); break;
      case 'fade-drift': kf('KFTypeAlpha', 0, 1); kf('KFTypePositionX', -0.02, 0); break;
      case 'fade-slide': kf('KFTypeAlpha', 0, 1); kf('KFTypePositionY', 0.03, 0); break;
      case 'pop-bounce': case 'lift-bounce': case 'stamp-in': case 'slam-zoom': kf('UNIFORM_SCALE', 0.6, 1.0); break;
      case 'slam-shake': kf('UNIFORM_SCALE', 0.7, 1.0); break;
      case 'slide-horizontal': kf('KFTypePositionX', -0.08, 0); break;
      default: break;
    }
  }
  // words: [{word, startUs, endUs, confidence}] (already in CapCut's microseconds -- see server.js
  // for the seconds->microseconds conversion at the tool boundary, same convention as everywhere else).
  // styleNameOrObj: a catalog name (string, resolved via findInCatalog) OR a full style object
  // (e.g. a caller's copy of a catalog entry with color/highlightColor overridden) -- passing the
  // object directly lets a client-specific accent color override survive without being silently
  // discarded by a re-lookup against the unmodified catalog entry.
  addCaptions(words, styleNameOrObj, opts = {}) {
    this._pushUndo();
    if (!words || !words.length) throw new Error('no words to caption (empty transcript)');
    const style = typeof styleNameOrObj === 'string' ? findInCatalog(CAPTION_STYLES, styleNameOrObj) : styleNameOrObj;
    if (!style) throw new Error(`unknown caption style: "${styleNameOrObj}" (use capcut_list_caption_styles)`);
    const tpl = this.templates().text;
    if (!tpl) throw new Error('no text template found. Set CAPCUT_TEMPLATE_DRAFT to a draft that contains a text layer.');
    const track = opts.trackIndex != null
      ? this.content.tracks[opts.trackIndex]
      : (this.content.tracks[this.addTrack('text', 'Captions')]);
    if (!track) throw new Error(`no track at index ${opts.trackIndex}`);
    const cues = capCueOverlaps(chunkWords(words, style));
    if (opts.previewCues != null) cues.length = Math.min(cues.length, opts.previewCues);
    const segmentIds = [];
    for (const cue of cues) {
      if (shouldKaraoke(cue, style)) {
        for (let i = 0; i < cue.words.length; i++) {
          const w = cue.words[i];
          const styles = buildWordRanges(cue.words, i, style, style.fontSize);
          const seg = this._buildCaptionSegment(tpl, cue.text, styles, w.startUs, Math.max(w.endUs - w.startUs, 1), track);
          segmentIds.push(seg.id);
        }
      } else {
        const styles = buildWordRanges(cue.words, -1, style, style.fontSize);
        const seg = this._buildCaptionSegment(tpl, cue.text, styles, cue.start, Math.max(cue.end - cue.start, 1), track);
        this._animateCaption(seg, style);
        segmentIds.push(seg.id);
      }
    }
    return { segmentIds, cueCount: cues.length, wordCount: words.length, style: style.name, trackIndex: this.content.tracks.indexOf(track), dryRun: false };
  }
  clearCaptionTrack(trackIndex) {
    this._pushUndo();
    const track = this.content.tracks[trackIndex];
    if (!track) throw new Error(`no track at index ${trackIndex}`);
    const ids = (track.segments || []).map(s => s.id);
    for (const id of ids) this.deleteSegment(id);
    return { trackIndex, removed: ids.length };
  }

  // ---------- validate ----------
  validate() {
    const c = this.content; const issues = [], warnings = [];
    const ids = new Set(); let dupMat = 0;
    for (const k of Object.keys(c.materials || {})) if (Array.isArray(c.materials[k])) for (const m of c.materials[k]) { if (ids.has(m.id)) dupMat++; ids.add(m.id); }
    if (dupMat) issues.push(`${dupMat} duplicate material id(s)`);
    let overlaps = 0;
    const ris = new Map();                                   // render_index -> [ {start,end} ] across all tracks
    for (const tr of c.tracks) {
      const ss = [...(tr.segments || [])].sort((a, b) => a.target_timerange.start - b.target_timerange.start);
      for (const s of ss) { const e = { a: s.target_timerange.start, b: s.target_timerange.start + s.target_timerange.duration }; (ris.get(s.render_index) || ris.set(s.render_index, []).get(s.render_index)).push(e); }
      for (let i = 1; i < ss.length; i++) if (ss[i].target_timerange.start < ss[i - 1].target_timerange.start + ss[i - 1].target_timerange.duration) overlaps++;
    }
    // a duplicate render_index only matters if those two segments actually overlap in time
    let riClash = 0;
    for (const arr of ris.values()) for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) if (arr[i].a < arr[j].b && arr[j].a < arr[i].b) riClash++;
    if (overlaps) issues.push(`${overlaps} overlapping segment(s) on a single track`);
    if (riClash) issues.push(`${riClash} overlapping segment pair(s) share a render_index (ambiguous layer order)`);
    else if (ris.size < [...ris.values()].reduce((n, a) => n + a.length, 0)) warnings.push('some non-overlapping segments share a render_index (harmless; CapCut does this for sequential clips)');
    for (const s of (c.materials?.videos || [])) if (s.path && !fs.existsSync(s.path)) issues.push(`missing media file: ${s.path}`);
    // a keyframe outside its own segment's span never fires -- CapCut just plays a static value,
    // silently, with no error of its own. addKeyframe() rejects this at write time, but capcut_raw_patch
    // can still inject one directly, so this is the last line of defense before save().
    for (const tr of c.tracks) for (const s of (tr.segments || [])) {
      const localDur = s.target_timerange?.duration;
      if (localDur == null) continue;
      for (const list of (s.common_keyframes || [])) for (const kf of (list.keyframe_list || [])) {
        if (kf.time_offset < 0 || kf.time_offset > localDur) issues.push(`keyframe out of range on segment ${s.id} (${list.property_type}): time_offset=${(kf.time_offset / US).toFixed(3)}s, segment duration=${(localDur / US).toFixed(3)}s`);
      }
    }
    // every extra_material_ref must resolve to a real material -- catches one getting dropped
    // between being created and being saved (e.g. a fade/filter/mask that silently disappears).
    for (const tr of c.tracks) for (const s of (tr.segments || [])) for (const id of (s.extra_material_refs || [])) {
      const [k] = findMat(c, id);
      if (k === null) issues.push(`segment ${s.id} references material ${id} which does not exist in any materials array`);
    }
    for (const s of (c.materials?.audio_fades || [])) {
      const referenced = c.tracks.some(tr => (tr.segments || []).some(seg => (seg.extra_material_refs || []).includes(s.id)));
      if (!referenced) warnings.push(`audio_fade material ${s.id} exists but is not referenced by any segment (orphaned)`);
    }
    // text `content` is a JSON string CapCut never validates for us -- a malformed one, or a
    // styles[].range outside the text's own bounds, would previously pass validate() clean and only
    // surface as a broken/missing caption after opening the draft in CapCut. Ranges are checked in
    // UTF-16 code units (JS string .length), matching how CapCut itself indexes them.
    for (const m of (c.materials?.texts || [])) {
      let parsed; try { parsed = JSON.parse(m.content); } catch { issues.push(`text material ${m.id} has malformed content (not valid JSON)`); continue; }
      if (!parsed.text) { issues.push(`text material ${m.id} has empty text`); continue; }
      const len = parsed.text.length;
      const ranges = [...(parsed.styles || [])].map(s => s.range).filter(Array.isArray).sort((a, b) => a[0] - b[0]);
      for (const [start, end] of ranges) {
        if (start < 0 || end > len || start >= end) issues.push(`text material ${m.id} has a style range [${start},${end}] outside its text bounds [0,${len}]`);
      }
      for (let i = 1; i < ranges.length; i++) if (ranges[i][0] < ranges[i - 1][1]) issues.push(`text material ${m.id} has overlapping style ranges [${ranges[i - 1]}] and [${ranges[i]}]`);
    }
    return { ok: issues.length === 0, issues, warnings };
  }

  // ---------- save ----------
  save({ force = false } = {}) {
    if (!force) {
      if (fs.existsSync(path.join(this.dir, '.locked'))) throw new Error('draft is locked (open in CapCut). Close CapCut, or pass force:true. Autosave will overwrite edits made while open.');
      if (capcutRunning()) throw new Error('CapCut is running. Close it before saving, or pass force:true.');
      let onDiskMtimeMs; try { onDiskMtimeMs = fs.statSync(this.contentPath).mtimeMs; } catch {}
      if (onDiskMtimeMs != null && onDiskMtimeMs !== this._loadedMtimeMs) throw new Error('draft was modified on disk since this session loaded it (edited elsewhere, e.g. in CapCut). Discard this session and start over, or pass force:true to overwrite those changes.');
    }
    const v = this.validate();
    if (!v.ok && !force) throw new Error(`refusing to save: ${v.issues.join('; ')} (fix the issues, or pass force:true to save anyway)`);
    const cPath = this.contentPath;
    try { fs.copyFileSync(cPath, cPath + '.mcpbak'); } catch {}
    const tmp = cPath + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(this.content)); fs.renameSync(tmp, cPath);
    if (this.meta) { try { fs.copyFileSync(this.metaPath, this.metaPath + '.mcpbak'); } catch {} const mt = this.metaPath + '.tmp'; fs.writeFileSync(mt, JSON.stringify(this.meta)); fs.renameSync(mt, this.metaPath); }
    this._loadedMtimeMs = fs.statSync(cPath).mtimeMs;
    return { saved: this.name, durationSec: +(this.content.duration / US).toFixed(3), validation: v };
  }
}

// clone a whole draft folder to a new name (valid scaffolding), optionally emptied
export function cloneDraft(base, newName, { empty = false } = {}) {
  const src = safeDraftPath(base), dst = safeDraftPath(newName);
  if (!fs.existsSync(path.join(src, 'draft_content.json'))) throw new Error(`base draft not found: ${base}`);
  if (fs.existsSync(dst)) throw new Error(`draft already exists: ${newName}`);
  fs.mkdirSync(dst, { recursive: true });
  for (const fn of fs.readdirSync(src)) {
    if (fn === '.locked' || fn.endsWith('.mcpbak') || fn.endsWith('.tmp')) continue; // don't propagate this tool's own sentinel/backup files
    const s = path.join(src, fn); try { if (fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(dst, fn)); } catch {}
  }
  if (empty) {
    const d = new CapCutDraft(newName);
    for (const k of Object.keys(d.content.materials)) if (Array.isArray(d.content.materials[k])) d.content.materials[k] = [];
    for (const tr of d.content.tracks) tr.segments = [];
    d.content.duration = 0; d.content.id = uid(); d.content.name = newName;
    fs.writeFileSync(path.join(dst, 'draft_content.json'), JSON.stringify(d.content));
  }
  return { created: newName, dir: dst };
}

function hexToRgb(hex) { const h = hex.replace('#', ''); return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255]; }
function deepMerge(t, s) { for (const k of Object.keys(s)) { if (s[k] && typeof s[k] === 'object' && !Array.isArray(s[k]) && t[k] && typeof t[k] === 'object') deepMerge(t[k], s[k]); else t[k] = s[k]; } return t; }

// ---- captions: chunk a word-level transcript into readable cues, per a caption style preset ----
const NUMERIC_TOKEN_RE = /[\d]/; // a word containing any digit -- price, percentage, count, date, etc.
function isNumericToken(word) { return NUMERIC_TOKEN_RE.test(word); }

// words: [{word, startUs, endUs, confidence}], already sorted by time. Groups into cues honoring
// chunkMaxWords/chunkMaxChars, a natural-pause break (>300ms gap), and the universal rule that a
// numeric token (price/%/count) always gets its own cue, never split across two.
function chunkWords(words, style) {
  const PAUSE_US = 300000;
  const cues = [];
  let cur = [];
  const curChars = () => cur.reduce((n, w) => n + w.word.length + 1, 0);
  const flush = () => { if (cur.length) { cues.push(cur); cur = []; } };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (isNumericToken(w.word)) { flush(); cues.push([w]); continue; }
    if (cur.length) {
      const gap = w.startUs - cur[cur.length - 1].endUs;
      const wouldExceedWords = cur.length + 1 > (style.chunkMaxWords || 6);
      const wouldExceedChars = curChars() + w.word.length + 1 > (style.chunkMaxChars || 30);
      if (gap > PAUSE_US || wouldExceedWords || wouldExceedChars) flush();
    }
    cur.push(w);
  }
  flush();
  return cues.map(cueWords => {
    const text = cueWords.map(w => w.word).join(' ');
    const cps = style.cps || 15;
    const minDurUs = Math.round((text.length / cps) * US);
    const spokenStart = cueWords[0].startUs, spokenEnd = cueWords[cueWords.length - 1].endUs;
    const end = Math.max(spokenEnd, spokenStart + minDurUs);
    return { words: cueWords, text, start: spokenStart, end };
  });
}
// cap each cue's displayed end at (nextCue.start - a small gap), so extending short cues for
// readability (CPS floor) never overlaps the next one
function capCueOverlaps(cues) {
  const GAP_US = 20000;
  for (let i = 0; i < cues.length - 1; i++) {
    const nextStart = cues[i + 1].start;
    if (cues[i].end > nextStart - GAP_US) cues[i].end = Math.max(cues[i].start + 1, nextStart - GAP_US);
  }
  return cues;
}
function shouldKaraoke(cue, style) {
  if (!style.karaoke) return false;
  if (!style.karaokeOnly) return true;
  // "benefit" (semantic) detection isn't implemented -- documented simplification, same heuristic as "number"
  return cue.words.length === 1 && isNumericToken(cue.words[0].word);
}
// builds a styles[] array covering the WHOLE cue text with one range per word (UTF-16 code units,
// via JS string .length -- matches how CapCut itself indexes ranges, and survives accents/emoji).
// activeIndex >= 0 highlights that one word (karaoke); -1 means every word shares the plain color.
function buildWordRanges(cueWords, activeIndex, style, fontSize) {
  const ranges = []; let cursor = 0;
  cueWords.forEach((w, i) => {
    const start = cursor, end = cursor + w.word.length;
    const active = activeIndex === i;
    const color = (active && style.highlightColor) ? style.highlightColor : style.color;
    ranges.push({ range: [start, end], size: fontSize, fill: { content: { solid: { color: hexToRgb(color) } } } });
    cursor = end + 1; // +1 for the joining space
  });
  return ranges;
}

export const _us = US;
