#!/usr/bin/env python3
"""Brief 196 — redaction pass for `vern --share`.

Usage: vern-redact.py <input.md> <output.md> [literal-path ...]

Reads vern's markdown capture and writes a shareable copy:
  - every literal path passed on argv (vern passes $HOME and the repo
    root) is replaced with `~` / `<repo>` respectively — vern prints
    the absolute repo path in its header, and diagnostics are only
    leaving the machine because this pass exists;
  - any other /Users/<name>/… path is anonymized to /Users/<user>/…;
  - token-shaped values are replaced in place: GitHub tokens
    (ghp_/gho_/github_pat_…), AWS access keys (AKIA…), Anthropic /
    OpenAI-style keys (sk-…, sk-ant-…), JWTs, `Bearer <value>`, and
    `key|token|secret|password = value` assignments.

Prints the number of redactions to stdout so vern can put it in its
one-line summary. Conservative by design: this runs on text that is
mostly git logs, tsc output and probe results — git SHAs, versions
and error text are diagnostic value and are NOT touched.
"""
import re
import sys


def redact(text: str, literals: list[str]) -> tuple[str, int]:
    count = 0

    def sub(pattern: str, repl: str, s: str, flags: int = 0) -> str:
        nonlocal count
        s2, n = re.subn(pattern, repl, s, flags=flags)
        count += n
        return s2

    # Literal paths, longest first so the repo root is consumed before
    # $HOME can partially rewrite it. Contract with scripts/vern:
    # argv literals are [$HOME, $REPO_ROOT] — home becomes `~`, the
    # repo root becomes `<repo>`, any further literal `<path>`.
    labels = ["~", "<repo>"]
    ordered = sorted(
        ((lit, labels[i] if i < len(labels) else "<path>") for i, lit in enumerate(literals) if lit),
        key=lambda pair: len(pair[0]),
        reverse=True,
    )
    for lit, label in ordered:
        if lit in text:
            count += text.count(lit)
            text = text.replace(lit, label)

    text = sub(r"/Users/[^/\s]+", "/Users/<user>", text)
    text = sub(r"gh[opusr]_[A-Za-z0-9]{20,}", "<redacted-token>", text)
    text = sub(r"github_pat_[A-Za-z0-9_]{20,}", "<redacted-token>", text)
    text = sub(r"AKIA[0-9A-Z]{16}", "<redacted-aws-key>", text)
    text = sub(r"sk-ant-[A-Za-z0-9_-]{10,}", "<redacted-api-key>", text)
    text = sub(r"sk-[A-Za-z0-9_-]{16,}", "<redacted-api-key>", text)
    text = sub(r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}", "<redacted-jwt>", text)
    text = sub(r"(?i)(bearer)\s+[A-Za-z0-9._~+/=-]+", r"\1 <redacted>", text)
    text = sub(
        r"(?i)\b(api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd)\b(\s*[:=]\s*)\S+",
        r"\1\2<redacted>",
        text,
    )
    return text, count


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: vern-redact.py <input> <output> [literal-path ...]", file=sys.stderr)
        return 2
    with open(sys.argv[1], encoding="utf-8") as f:
        text = f.read()
    out, count = redact(text, sys.argv[3:])
    with open(sys.argv[2], "w", encoding="utf-8") as f:
        f.write(out)
    print(count)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
