#!/usr/bin/env bash
set -euo pipefail

if [[ "${GITHUB_ACTIONS:-}" != true || "${RUNNER_ENVIRONMENT:-}" != github-hosted ]]; then
  echo 'Browser dependency preparation is restricted to GitHub-hosted CI.' >&2
  exit 1
fi

# Regional mirrors have stalled cold browser installs past the job deadline.
# Change only the Ubuntu archive URI; retain suites, components and Signed-By.
sudo python3 - <<'PY'
from pathlib import Path
import re

release = Path('/etc/os-release').read_text()
if not re.search(r'^ID=ubuntu$', release, re.M) or not re.search(r'^VERSION_ID="24\.04"$', release, re.M):
    raise SystemExit('Browser CI requires Ubuntu 24.04.')

sources = [Path('/etc/apt/sources.list'), *Path('/etc/apt/sources.list.d').glob('*.sources'),
           *Path('/etc/apt/sources.list.d').glob('*.list')]
archive = re.compile(r'https?://(?:[a-z0-9-]+\.)*archive\.ubuntu\.com/ubuntu/?(?=\s|$)')
changed = 0
for path in sources:
    if not path.exists():
        continue
    original = path.read_text()
    updated, matches = archive.subn('https://archive.ubuntu.com/ubuntu/', original)
    changed += matches
    if updated != original:
        path.write_text(updated)
if not changed:
    raise SystemExit('No recognized Ubuntu archive source; review the runner image.')
print(f'Browser CI: {changed} Ubuntu archive URIs use the official HTTPS archive.')
PY
