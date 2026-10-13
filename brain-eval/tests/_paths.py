import os, sys
BRAIN_EVAL = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BRAIN_EVAL not in sys.path:
    sys.path.insert(0, BRAIN_EVAL)
