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
const normName = s => String(s).toLowerCase().replace(/[\s_-]/g, '');
export function findInCatalog(catalog, name) {
  const target = normName(name);
  return catalog.find(e => normName(e.name) === target) || null;
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
    return {
      name: this.name, durationSec: +(c.duration / US).toFixed(3), fps: c.fps,
      canvas: c.canvas_config && { w: c.canvas_config.width, h: c.canvas_config.height, ratio: c.canvas_config.ratio },
      locked: fs.existsSync(path.join(this.dir, '.locked')), capcutRunning: capcutRunning(),
      tracks: (c.tracks || []).map((tr, ti) => ({
        index: ti, type: tr.type, name: tr.name, segments: (tr.segments || []).map(s => {
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
    s.common_keyframes = s.common_keyframes || [];
    let list = s.common_keyframes.find(k => k.property_type === propertyType);
    if (!list) { list = { id: uid(), material_id: '', property_type: propertyType, keyframe_list: [] }; s.common_keyframes.push(list); }
    const entry = { id: uid(), time_offset: atUs, values: [value], curveType: 'Line', graphID: '', left_control: { x: 0, y: 0 }, right_control: { x: 0, y: 0 } };
    const idx = list.keyframe_list.findIndex(k => k.time_offset === atUs);
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

export const _us = US;
