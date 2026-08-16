#!/bin/bash
# Run once per clone — .git/hooks is untracked by design, so the hook lives
# in tools/ and this installs it. (Same pattern as the mobile repo.)
cd "$(git rev-parse --show-toplevel)"
cp tools/pre-commit .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
echo "installed: .git/hooks/pre-commit"
