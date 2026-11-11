"""Read-only immutable brain generation reader.
TWIN: brain-eval/generation_state.py (evaluation branch); protocol matches
src/common/brain-generation.ts. Invalid active generations never fall back.
"""
import hashlib
import json
import re
import struct
from pathlib import Path


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def packed(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False).encode()


def records(raw):
    if len(raw) < 12 or raw[:4] != b'EMBD':
        raise ValueError('invalid generation header')
    version, dim, count = struct.unpack_from('<HHI', raw, 4)
    size = 4 + dim * 4
    if version != 1 or dim != 1536 or len(raw) != 12 + count * size:
        raise ValueError('invalid generation binary shape')
    import math
    out = {}
    for off in range(12, len(raw), size):
        tid = struct.unpack_from('<I', raw, off)[0]
        vec = raw[off + 4:off + size]
        values = struct.unpack('<1536f', vec)
        if tid in out or not all(map(math.isfinite, values)) or not any(values):
            raise ValueError('invalid generation record')
        out[tid] = vec
    return out


def pointer(root, local=False):
    p = root / ('brain-local-overlay.json' if local else 'brain-generation.json')
    if not p.exists():
        return None
    obj = json.loads(p.read_bytes())
    for key in ('base', 'overlay'):
        if key == 'overlay' and obj.get(key) is None:
            continue
        if not re.fullmatch('[a-f0-9]{64}', str(obj.get(key, ''))):
            raise ValueError('invalid generation ID')
    expected = digest(packed({'v': 1, 'base': obj['base'], 'overlay': obj['overlay']}))
    if obj.get('v') != 1 or obj.get('revision') != expected:
        raise ValueError('invalid generation pointer checksum')
    return obj


def artifact(root, ident, local=False):
    if not re.fullmatch('[a-f0-9]{64}', str(ident)):
        raise ValueError('invalid generation ID')
    folder = root / ('brain-local-generations' if local else 'brain-generations') / ident
    raw = (folder / 'manifest.json').read_bytes()
    if digest(raw) != ident:
        raise ValueError('generation manifest hash mismatch')
    manifest = json.loads(raw)
    mood = (folder / 'mood-index.bin').read_bytes()
    desc = (folder / 'brain-descriptors.json').read_bytes()
    if manifest.get('v') != 1 or manifest.get('artifacts') != {'moodSha256': digest(mood), 'descriptorsSha256': digest(desc)}:
        raise ValueError('generation artifacts mismatch')
    records(mood)
    descriptors = json.loads(desc)
    if not isinstance(descriptors, dict):
        raise ValueError('invalid generation descriptors')
    kind, evaluation = manifest.get('kind'), manifest.get('evaluation')
    if kind == 'evaluated-base':
        deps = evaluation.get('dependencies', {}) if isinstance(evaluation, dict) else {}
        if not re.fullmatch('[a-f0-9]{64}', str(deps.get('semanticSha256', ''))) or not re.fullmatch('[a-f0-9]{40}', str(deps.get('mainSourceCommit', ''))) or (deps.get('audioSha256') is not None and not re.fullmatch('[a-f0-9]{64}', str(deps['audioSha256']))):
            raise ValueError('invalid evaluation dependency identity')
        identity = digest(packed({'moodSha256': digest(mood), 'descriptorsSha256': digest(desc)}))
        if not isinstance(evaluation, dict) or evaluation.get('passed') is not True or evaluation.get('effectiveSnapshotSha256') != identity:
            raise ValueError('invalid generation evaluation binding')
    elif kind != 'incremental-overlay' or evaluation is not None:
        raise ValueError('invalid overlay provenance')
    return manifest, mood, descriptors


def snapshot(directory, include_local=True):
    root = Path(directory)
    hub = pointer(root)
    if hub is None:
        return None
    local = pointer(root, True) if include_local else None
    refs = [(hub['base'], False, 'evaluated-base')]
    if hub['overlay']:
        refs.append((hub['overlay'], False, 'incremental-overlay'))
    if local and local['overlay']:
        # Validate local base as well; never accept an incomplete local store.
        artifact(root, local['base'], True)
        refs.append((local['overlay'], True, 'incremental-overlay'))
    vectors, descriptors, conflicts = {}, {}, set()
    for ident, is_local, kind in refs:
        manifest, mood, desc = artifact(root, ident, is_local)
        if manifest.get('kind') != kind:
            raise ValueError('generation kind mismatch')
        pending = records(mood)
        if is_local and manifest.get('sourceRevision') != hub['revision']:
            conflicts.update(tid for tid, value in pending.items() if tid in vectors and vectors[tid] != value)
            conflicts.update(int(tid) for tid, value in desc.items() if tid in descriptors and descriptors[tid] != value)
        vectors.update({tid: value for tid, value in pending.items() if tid not in conflicts})
        descriptors.update({tid: value for tid, value in desc.items() if int(tid) not in conflicts})
    # JSON.stringify orders integer-like object keys before other properties.
    def key_order(key):
        numeric = key.isdigit() and str(int(key)) == key and int(key) < 4294967295
        return (0, int(key)) if numeric else (1, list(descriptors).index(key))
    descriptors = {key: descriptors[key] for key in sorted(descriptors, key=key_order)}
    mood = b'EMBD' + struct.pack('<HHI', 1, 1536, len(vectors)) + b''.join(struct.pack('<I', tid) + vectors[tid] for tid in sorted(vectors))
    base, _, _ = artifact(root, hub['base'])
    deps = base['evaluation'].get('dependencies') or {}
    mismatches = []
    for file, expected in (('embeddings.bin', deps.get('semanticSha256')), ('audio-index.bin', deps.get('audioSha256')), ('library.json', base['librarySha256'])):
        try:
            actual = digest((root / file).read_bytes()) if (root / file).exists() else None
            if actual != expected:
                mismatches.append(file)
        except OSError:
            mismatches.append(file)
    try:
        cap = json.loads((root / 'brain-generation-capabilities.json').read_bytes())
        if cap.get('mainSourceCommit') != deps.get('mainSourceCommit'):
            mismatches.append('mainSourceCommit')
        if cap.get('v') != 1 or cap.get('activationEnabled') is not True or any(cap.get('consumers', {}).get(k) != 1 for k in ('desktop', 'mobile', 'trainer', 'taste', 'evaluation', 'sync')):
            mismatches.append('localCapabilities')
    except (OSError, ValueError):
        mismatches.append('localCapabilities')
    return {'evaluationApplicable': not mismatches and not hub['overlay'] and not (local and local['overlay']), 'dependencyMismatches': mismatches, 'mood': mood, 'descriptors': packed(descriptors), 'hubRevision': hub['revision'],
            'localRevision': local['revision'] if local else None, 'baseId': hub['base'],
            'hasUnvalidatedOverlay': bool(hub['overlay'] or (local and local['overlay'])), 'overlayConflicts': sorted(conflicts)}


def read_descriptors(directory):
    active = snapshot(directory)
    if active:
        return json.loads(active['descriptors'])
    path = Path(directory) / 'brain-descriptors.json'
    return json.loads(path.read_bytes()) if path.exists() else {}
