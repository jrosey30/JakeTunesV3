"""Offline regression controls only: temporary state/repos, no provider calls."""
import ast
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import numpy as np
import _paths
import generation_state as G
import generation_receipt as R
import scorecard as S
import test_generation_receipt as receipt_tests


def evaluator(**globals_):
    path = Path(__file__).resolve().parents[1] / 'run_eval.py'
    tree = ast.parse(path.read_text())
    names = {'read_embeddings', 'sha_of', 'v1_mood_diag', 'expected_ids',
             'retrieve_topk', 'recall_at_k', 'append_jsonl', 'evaluator_provenance',
             'check_citations_v3', 'title_index', 'v3_self_test'}
    ns = dict(os=os, json=json, hashlib=hashlib, struct=struct, np=np,
              sys=sys, EMBED_MAGIC=b'EMBD', EMBED_DIM=1536, **globals_)
    exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n, ast.FunctionDef)
                                 and n.name in names], type_ignores=[]), str(path), 'exec'), ns)
    return ns


class GenerationOnlyTests(unittest.TestCase):
    def fixture(self, root):
        mood = b'EMBD' + struct.pack('<HHII', 1, 1536, 1, 1) + struct.pack('<1536f', 1, *([0] * 1535))
        desc = b'{"1":{"d":"offline test"}}'
        library = b'{"tracks":[{"id":1,"artist":"Artist"}]}'
        (root / 'embeddings.bin').write_bytes(mood)
        (root / 'library.json').write_bytes(library)
        identity = G.digest(G.packed({'moodSha256':G.digest(mood), 'descriptorsSha256':G.digest(desc)}))
        manifest = {'v':1,'kind':'evaluated-base','librarySha256':G.digest(library),
                    'artifacts':{'moodSha256':G.digest(mood),'descriptorsSha256':G.digest(desc)},
                    'evaluation':{'passed':True,'effectiveSnapshotSha256':identity,
                                  'dependencies':{'semanticSha256':G.digest(mood),'audioSha256':None,'mainSourceCommit':'b'*40}}}
        raw=G.packed(manifest); ident=G.digest(raw)
        folder=root/'brain-generations'/ident;folder.mkdir(parents=True)
        (folder/'manifest.json').write_bytes(raw)
        (folder/'mood-index.bin').write_bytes(mood)
        (folder/'brain-descriptors.json').write_bytes(desc)
        pointer={'v':1,'base':ident,'overlay':None}
        (root/'brain-generation.json').write_bytes(G.packed({**pointer,'revision':G.digest(G.packed(pointer))}))
        (root/'brain-generation-capabilities.json').write_text(json.dumps({'v':1,'activationEnabled':True,'mainSourceCommit':'b'*40,'consumers':dict.fromkeys(('desktop','mobile','trainer','taste','evaluation','sync'),1)}))
        return mood, folder

    def test_generation_only_v1_and_v3_share_measured_mood_identity(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);mood,_=self.fixture(root);ns=evaluator(STATE_DIR=d)
            self.assertFalse((root/'mood-index.bin').exists())
            self.assertTrue(G.snapshot(root)['evaluationApplicable'])
            query=np.array([1]+[0]*1535,dtype=np.float32)
            scores, identity=ns['v1_mood_diag']([{'id':'one','bucket':'retrieval','query':'q','expected':{'artist':'Artist'},'k':1}], [{'id':1,'artist':'Artist'}], {'q':query})
            self.assertEqual(scores,{'one':1.0})
            self.assertEqual(identity,hashlib.sha1(mood).hexdigest()[:12])
            # Same read/hash path as main_v3, without running inference.
            ids,_,meta=ns['read_embeddings'](str(root/'mood-index.bin'))
            self.assertEqual(list(ids),[1]);self.assertEqual(meta['count'],1)
            self.assertEqual(identity,ns['sha_of'](str(root/'mood-index.bin')))
            args=receipt_tests.CompleteRunTests().fixture()
            for i in (0,2,4,6):args[i]['mood_id']=identity
            R.validate_runs(*args)

    def test_invalid_generation_never_becomes_missing_or_flat_fallback(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);mood,folder=self.fixture(root);ns=evaluator(STATE_DIR=d)
            (root/'mood-index.bin').write_bytes(mood)
            (folder/'mood-index.bin').write_bytes(mood+b'bad')
            with self.assertRaises(ValueError):ns['v1_mood_diag']([],[],{})
            (root/'mood-index.bin').unlink()
            with self.assertRaises(ValueError):ns['v1_mood_diag']([],[],{})

    def test_legacy_missing_and_present_mood(self):
        with tempfile.TemporaryDirectory() as d:
            ns=evaluator(STATE_DIR=d)
            self.assertEqual(ns['v1_mood_diag']([],[],{}),({},None))
            raw=b'EMBD'+struct.pack('<HHI',1,1536,0)
            (Path(d)/'mood-index.bin').write_bytes(raw)
            self.assertEqual(ns['v1_mood_diag']([],[],{})[1],hashlib.sha1(raw).hexdigest()[:12])


class OutputProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.brain=self.root/'brain-eval';self.brain.mkdir()
        for name in ('score_log.jsonl','score_rows.jsonl','run_eval.py','eval_set.json','eval_set_v3.json','vocab_snapshot.json','eval_set_v3.qvec.json'):
            (self.brain/name).write_text('')
        (self.root/'package-lock.json').write_text('{}')
        self.git('init','-q');self.git('add','.')
        self.git('-c','user.name=Offline Test','-c','user.email=offline@example.invalid','commit','-qm','Synthetic test fixture')
        self.ns=evaluator(REPO=str(self.root))
    def git(self,*args):
        return subprocess.check_output(['git',*args],cwd=self.root,text=True,stderr=subprocess.STDOUT)
    def test_four_run_default_logs_do_not_dirty_evaluator(self):
        initial=self.ns['evaluator_provenance']();self.assertFalse(initial[1])
        args=receipt_tests.CompleteRunTests().fixture()
        for i in (0,2,4,6):
            summary=args[i];summary['limit']=0
            commit,dirty=self.ns['evaluator_provenance']()
            summary.update(evaluator_commit=commit,evaluator_dirty=dirty)
            self.ns['append_jsonl'](str(self.brain/'score_log.jsonl'),[summary])
            self.ns['append_jsonl'](str(self.brain/'score_rows.jsonl'),args[i+1])
            self.assertEqual(self.ns['evaluator_provenance'](),initial)
        self.assertIn('score_log.jsonl',self.git('status','--porcelain'))
        R.validate_runs(*args)
        # Staged output appends also must not change input provenance.
        self.git('add','brain-eval/score_log.jsonl')
        self.assertEqual(self.ns['evaluator_provenance'](),initial)
    def test_code_dependency_probe_and_similarly_named_files_remain_dirty(self):
        for name in ('brain-eval/run_eval.py','brain-eval/eval_set.json','brain-eval/eval_set_v3.json','brain-eval/vocab_snapshot.json','brain-eval/eval_set_v3.qvec.json','package-lock.json','brain-eval/new-helper.py','brain-eval/sub/score_log.jsonl','brain-eval/score_log.jsonl.py'):
            with self.subTest(path=name):
                p=self.root/name;p.parent.mkdir(exist_ok=True);old=p.read_bytes() if p.exists() else None
                p.write_bytes(b'changed')
                self.assertTrue(self.ns['evaluator_provenance']()[1])
                self.git('add',name);self.assertTrue(self.ns['evaluator_provenance']()[1])
                self.git('reset','-q','HEAD','--',name)
                if old is None:p.unlink()
                else:p.write_bytes(old)
                self.assertFalse(self.ns['evaluator_provenance']()[1])
    def test_git_failure_is_not_clean(self):
        with patch('subprocess.check_output',side_effect=subprocess.CalledProcessError(1,'git')):
            with self.assertRaises(subprocess.CalledProcessError):self.ns['evaluator_provenance']()


class FullRunLimitTests(unittest.TestCase):
    def test_only_none_or_integer_zero_means_complete(self):
        for value in (None,0,False,True,1,-1,'0',0.0):
            args=receipt_tests.CompleteRunTests().fixture()
            for i in (0,2,4,6):args[i]['limit']=value
            if value is None or type(value) is int and value==0:R.validate_runs(*args)
            else:
                with self.assertRaises(ValueError):R.validate_runs(*args)


class ValidatorSelfTestTests(unittest.TestCase):
    def test_ambiguous_library_does_not_invalidate_positive_control(self):
        vocab=S.Vocab({'leaves':{'Rock':{'family':'F'},'Pop':{'family':'F'}},'families':{'F':{'leaves':['Rock','Pop']}},'umbrellas':{}})
        ns=evaluator()
        tracks=[{'title':'Song','artist':'Artist','genre':'Rock'}, {'title':'Song (Live)','artist':'Artist','genre':'Pop'}]
        with contextlib.redirect_stdout(io.StringIO()):
            ns['v3_self_test'](tracks,vocab)
            ns['v3_self_test']([],vocab)
        self.assertEqual(ns['check_citations_v3']([{'title':'Song','artist':'Artist'}],ns['title_index'](tracks),S.compile_predicate({'genre_leaf':'Rock'},vocab))[1],1)
    def test_validator_regression_still_aborts(self):
        vocab=S.Vocab({'leaves':{'Rock':{'family':'F'},'Pop':{'family':'F'}},'families':{'F':{'leaves':['Rock','Pop']}},'umbrellas':{}})
        ns=evaluator();ns['check_citations_v3']=lambda *a:(1,0,[])
        with contextlib.redirect_stderr(io.StringIO()),self.assertRaises(SystemExit):ns['v3_self_test']([],vocab)
