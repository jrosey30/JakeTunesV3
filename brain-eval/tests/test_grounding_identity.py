"""Offline grounding contract; no model calls, state reads or ruler edits."""
import ast
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

def checker():
    source = Path(__file__).resolve().parents[1] / 'run_eval.py'
    tree = ast.parse(source.read_text())
    functions = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in ('check_citations_v3', 'title_index')]
    ns = {}
    exec(compile(ast.Module(body=functions, type_ignores=[]), str(source), 'exec'), ns)
    return ns

class IdentityTests(unittest.TestCase):
    def test_invalid_identities_fail(self):
        ns = checker()
        idx = ns['title_index']([{'title':'Song', 'artist':'Artist Long', 'year':2000}])
        for citation in ({'title':'Invented','artist':'Artist Long'}, {'title':'Song','artist':'Artist'}, {'title':'Song'}, {}, {'title':'Song','artist':'Wrong'}):
            self.assertEqual(ns['check_citations_v3']([citation], idx, lambda t: True)[1], 1)
        self.assertEqual(ns['check_citations_v3']([{'title':'Song','artist':'Artist Long'}],idx,lambda t:True)[:2], (1,0))
    def test_ambiguous_version_cannot_borrow_predicate(self):
        ns=checker()
        idx=ns['title_index']([{'title':'Song','artist':'Artist','year':1970},{'title':'Song (Live)','artist':'Artist','year':2000}])
        self.assertEqual(ns['check_citations_v3']([{'title':'Song','artist':'Artist'}],idx,lambda t:t['year']==1970)[1],1)
