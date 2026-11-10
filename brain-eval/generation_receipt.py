#!/usr/bin/env python3
"""Offline receipt construction. No inference, training or live activation.
A receipt is emitted only from comparable, complete dual-ruler passing runs
whose measured hashes match the exact candidate artifacts supplied.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import math
import gate
from generation_state import digest, packed, records


def validate_runs(base, base_rows, candidate, candidate_rows, v1_base, v1_base_rows, v1_candidate, v1_candidate_rows):
    root = Path(__file__).parent
    for summary, rows, ruler in ((base, base_rows, 'v3'), (candidate, candidate_rows, 'v3'), (v1_base, v1_base_rows, 'v1'), (v1_candidate, v1_candidate_rows, 'v1')):
        raw = (root / ('eval_set_v3.json' if ruler == 'v3' else 'eval_set.json')).read_bytes()
        spec = json.loads(raw)
        if summary.get('ruler') != ruler or summary.get('limit') is not None or summary.get('no_llm') is not False:
            raise ValueError('complete measured ruler required')
        if summary.get('eval_set_sha') != hashlib.sha1(raw).hexdigest()[:12]:
            raise ValueError('ruler file identity mismatch')
        expected = ({p['id']: p['group'] for p in spec['probes']} | {p['id']: 'grounding' for p in spec['grounding']}) if ruler == 'v3' else {p['id']: p['bucket'] for p in spec['prompts'] if p['bucket'] != 'persona'}
        if len(rows) != len(expected) or len({r.get('probe_id') for r in rows}) != len(rows):
            raise ValueError('missing or duplicate evaluation probes')
        for row in rows:
            score = row.get('score')
            if expected.get(row.get('probe_id')) != row.get('group') or isinstance(score, bool) or not isinstance(score, (int, float)) or not math.isfinite(score):
                raise ValueError('unmeasured or unexpected evaluation probe')
    for field in ('model', 'grounding_validator', 'eval_set_sha'):
        if not v1_base.get(field) or v1_base[field] != v1_candidate.get(field):
            raise ValueError('incomparable v1 continuity run')
    for old, new in ((v1_base, base), (v1_candidate, candidate)):
        for field in ('brain_id', 'mood_id', 'library_sha', 'model'):
            if not old.get(field) or old[field] != new.get(field):
                raise ValueError('v1 continuity run does not describe corresponding v3 inputs')


def build_manifest(base, base_rows, candidate, candidate_rows, v1_base, v1_base_rows,
                   v1_candidate, v1_candidate_rows, mood, descriptors, library):
    for field in ('model', 'grounding_validator', 'eval_set_sha', 'vocab_sha', 'primary_source', 'main_src_sha'):
        if not base.get(field) or base.get(field) != candidate.get(field):
            raise ValueError(f'incomparable evaluation {field}')
    if candidate.get('primary_source') != 'bridge' or candidate.get('limit') or candidate.get('no_llm'):
        raise ValueError('complete production-path evaluation with grounding is required')
    if candidate.get('ruler') != 'v3' or base.get('ruler') != 'v3':
        raise ValueError('v3 paired evaluation required')
    if candidate.get('evaluator_dirty') is not False or not re.fullmatch('[a-f0-9]{40}', str(candidate.get('evaluator_commit', ''))):
        raise ValueError('evaluation must identify a clean committed evaluator')
    validate_runs(base, base_rows, candidate, candidate_rows, v1_base, v1_base_rows, v1_candidate, v1_candidate_rows)
    v3 = gate.v3_gate(base_rows, candidate_rows, candidate.get('grounding'))
    v1 = gate.v1_bar(v1_base, v1_candidate, v1_base_rows, v1_candidate_rows)
    if not gate.dual_run_decision(v1, v3)['apply']:
        raise ValueError('dual-ruler gate rejected candidate; no publication receipt')
    records(mood)
    d = json.loads(descriptors)
    if not isinstance(d, dict):
        raise ValueError('descriptor artifact must be an object')
    identity = digest(packed({'moodSha256': digest(mood), 'descriptorsSha256': digest(descriptors)}))
    binding = candidate.get('generation_binding') or {}
    expected = {'moodSha256': digest(mood), 'descriptorsSha256': digest(descriptors),
                'librarySha256': digest(library), 'effectiveSnapshotSha256': identity}
    if any(binding.get(k) != v for k, v in expected.items()):
        raise ValueError('candidate artifacts differ from the evaluated effective snapshot')
    # Tie the continuity run to the same bytes, not a different successful run.
    if v1_candidate.get('brain_id') != candidate.get('brain_id') or v1_candidate.get('mood_id') != candidate.get('mood_id') or v1_candidate.get('library_sha') != candidate.get('library_sha'):
        raise ValueError('v1 continuity run does not describe the same candidate')
    dependencies = binding.get('dependencies') or {}
    if not re.fullmatch('[a-f0-9]{64}', str(dependencies.get('semanticSha256', ''))) or (dependencies.get('audioSha256') is not None and not re.fullmatch('[a-f0-9]{64}', str(dependencies['audioSha256']))) or not re.fullmatch('[a-f0-9]{40}', str(dependencies.get('mainSourceCommit', ''))) or dependencies['mainSourceCommit'] != candidate.get('main_src_sha'):
        raise ValueError('missing exact evaluated dependency identity')
    versions = sorted({str(v.get('pv', 'legacy')) for v in d.values() if isinstance(v, dict)})
    return {'v': 1, 'kind': 'evaluated-base', 'parentRevision': binding.get('parentRevision'),
            'librarySha256': expected['librarySha256'],
            'artifacts': {k: expected[k] for k in ('moodSha256', 'descriptorsSha256')},
            'evaluation': {'passed': True, 'runId': candidate['run_id'], 'ruler': 'v3',
                'evaluatorCommit': candidate['evaluator_commit'], 'model': candidate['model'],
                'promptVersion': 'descriptors:' + ','.join(versions) + ';grounding:' + candidate['grounding_validator'],
                'effectiveSnapshotSha256': identity, 'dependencies': dependencies}}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    for name in ('base', 'candidate', 'v1-base', 'v1-candidate', 'log-dir', 'snapshot-dir', 'output'):
        p.add_argument('--' + name, required=True)
    a = p.parse_args()
    bs, br = gate.load_run(a.log_dir, a.base)
    cs, cr = gate.load_run(a.log_dir, a.candidate)
    vb, vbr = gate.load_run(a.log_dir, a.v1_base)
    vc, vcr = gate.load_run(a.log_dir, a.v1_candidate)
    root = Path(a.snapshot_dir).resolve()
    output = Path(a.output).resolve()
    import scorecard
    for live in scorecard.LIVE_STATE_DIRS:
        live_path = Path(live).resolve()
        if output == live_path or live_path in output.parents:
            raise ValueError('receipt output must not be in a live brain directory')
    if output.parent != root or output.name != 'manifest.json':
        raise ValueError('receipt output must be manifest.json in the explicit scratch snapshot directory')
    manifest = build_manifest(bs, br, cs, cr, vb, vbr, vc, vcr,
        (root / 'mood-index.bin').read_bytes(), (root / 'brain-descriptors.json').read_bytes(), (root / 'library.json').read_bytes())
    # Exclusive create: never overwrite a receipt or a live artifact.
    with open(a.output, 'xb') as f:
        f.write(packed(manifest))
    print(digest(packed(manifest)))

if __name__ == '__main__':
    main()
