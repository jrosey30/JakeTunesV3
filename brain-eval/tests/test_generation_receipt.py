import sys
from pathlib import Path
import struct
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import generation_receipt as R

class ReceiptTests(unittest.TestCase):
    def fixture(self):
        mood = b'EMBD' + struct.pack('<HHII', 1, 1536, 1, 1) + struct.pack('<1536f', 1, *([0] * 1535))
        desc, lib = b'{"1":{"d":"fixture","pv":3}}', b'{"tracks":[{"id":1}]}'
        identity = R.digest(R.packed({'moodSha256': R.digest(mood), 'descriptorsSha256': R.digest(desc)}))
        base = {'ruler':'v3','model':'fixture','grounding_validator':'v2','eval_set_sha':'ruler','vocab_sha':'vocab','primary_source':'bridge','main_src_sha':'b'*40}
        cand = {**base,'limit':None,'no_llm':False,'evaluator_dirty':False,'evaluator_commit':'a'*40,'grounding':1,
                'brain_id':'main-id','mood_id':'mood-id','library_sha':'library-id','run_id':'fixture',
                'generation_binding':{'moodSha256':R.digest(mood),'descriptorsSha256':R.digest(desc),'librarySha256':R.digest(lib),'effectiveSnapshotSha256':identity,'parentRevision':None,'dependencies':{'semanticSha256':R.digest(mood),'audioSha256':None,'mainSourceCommit':'b'*40}}}
        return [base, [], cand, [], {}, [], cand.copy(), [], mood, desc, lib]

    @patch.object(R, 'validate_runs')
    @patch.object(R.gate, 'v1_bar', return_value={'pass':True})
    @patch.object(R.gate, 'v3_gate', return_value={'pass':True})
    def test_receipt_binds_exact_bytes(self, *_):
        args=self.fixture()
        manifest=R.build_manifest(*args)
        self.assertTrue(manifest['evaluation']['passed'])
        self.assertEqual(manifest['artifacts']['moodSha256'], R.digest(args[-3]))
        args[-2] += b' '
        with self.assertRaisesRegex(ValueError, 'differ from'):
            R.build_manifest(*args)

    @patch.object(R, 'validate_runs')
    @patch.object(R.gate, 'v1_bar', return_value={'pass':True})
    @patch.object(R.gate, 'v3_gate', return_value={'pass':False})
    def test_gate_failure_never_gets_receipt(self, *_):
        with self.assertRaisesRegex(ValueError, 'rejected'):
            R.build_manifest(*self.fixture())

    def test_old_model_dirty_and_partial_runs_refused(self):
        for field, value in [('model','other-model'),('evaluator_dirty',True),('limit',1),('primary_source','py-router')]:
            args=self.fixture(); args[2][field]=value
            with self.assertRaises(ValueError):
                R.build_manifest(*args)

class CompleteRunTests(unittest.TestCase):
    def fixture(self):
        import json, hashlib
        result=[]
        for ruler in ('v3', 'v3', 'v1', 'v1'):
            raw=(Path(R.__file__).parent / ('eval_set_v3.json' if ruler=='v3' else 'eval_set.json')).read_bytes()
            spec=json.loads(raw)
            probes=([(p['id'],p['group']) for p in spec['probes']]+[(p['id'],'grounding') for p in spec['grounding']]) if ruler=='v3' else [(p['id'],p['bucket']) for p in spec['prompts'] if p['bucket']!='persona']
            summary={'ruler':ruler,'limit':None,'no_llm':False,'model':'fixture','grounding_validator':ruler,'eval_set_sha':hashlib.sha1(raw).hexdigest()[:12],'brain_id':'brain','mood_id':'mood','library_sha':'library'}
            result.extend([summary,[{'probe_id':i,'group':g,'score':1.0} for i,g in probes]])
        return result
    def test_full_comparable_probe_sets(self):
        R.validate_runs(*self.fixture())
    def test_unrelated_v1_baseline_and_wrong_ruler_refused(self):
        for field in ('model','library_sha','brain_id','mood_id','ruler','eval_set_sha','grounding_validator'):
            args=self.fixture();args[4][field]='different'
            with self.assertRaises(ValueError): R.validate_runs(*args)
    def test_incomplete_duplicate_and_unmeasured_refused(self):
        for side in (1,3,5,7):
            args=self.fixture();args[side]=args[side][:1]
            with self.assertRaises(ValueError): R.validate_runs(*args)
            args=self.fixture();args[side][-1]=args[side][0]
            with self.assertRaises(ValueError): R.validate_runs(*args)
            args=self.fixture();args[side][0]['score']=None
            with self.assertRaises(ValueError): R.validate_runs(*args)
