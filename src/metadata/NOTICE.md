# Provenance & license of the bundled catalogs

`filters.json`, `transitions.json`, and `masks.json` in this directory contain **data only**
(names, `resource_id`/`effect_id` pairs, parameter ranges) extracted from Python source files
in [sun-guannan/VectCutAPI](https://github.com/sun-guannan/VectCutAPI), which vendors a fork of
[GuanYixuan/pyJianYingDraft](https://github.com/GuanYixuan/pyJianYingDraft) — both licensed under
the **Apache License 2.0**. No code from either project is reused here, only the factual
resource/effect identifiers, converted from Python enum literals to JSON.

- `filters.json` ← `pyJianYingDraft/metadata/filter_meta.py` (474 entries)
- `transitions.json` ← `pyJianYingDraft/metadata/capcut_transition_meta.py` (116 entries, CapCut-specific)
- `masks.json` ← `pyJianYingDraft/metadata/capcut_mask_meta.py` (9 entries, CapCut-specific)

A copy of the Apache License 2.0 is available at <http://www.apache.org/licenses/LICENSE-2.0>.

**Caveat on `filters.json`:** VectCutAPI ships one `filter_meta.py` shared between JianYing and
CapCut (there is no separate `capcut_filter_meta.py`, unlike transitions/masks which do have a
CapCut-specific file). Most basic filters are believed to share resource IDs across both apps,
but this hasn't been independently confirmed against a real CapCut install — if `capcut_add_filter`
produces a no-op or wrong-looking filter, that's why. Transitions and masks come from CapCut-specific
files and are higher-confidence.

Note: an earlier version of this catalog was sourced from `GuanYixuan/pyCapCut`, which carries
**no license file at all** — that data has been removed and replaced with the properly-licensed
source above.
