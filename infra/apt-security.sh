#!/bin/sh
set -eu
export DEBIAN_FRONTEND=noninteractive
# CVE-2026-109518: disable retries while updating the vulnerable base APT,
# then install the signed, exact security fix before any other package operation.
apt-get -o Acquire::Retries=0 update
. /etc/os-release
case "$ID" in
  debian) apt_fix=2.6.2; apt_library=libapt-pkg6.0 ;;
  ubuntu) apt_fix=2.8.4ubuntu0.1; apt_library=libapt-pkg6.0t64 ;;
  *) echo "Unsupported security update distribution" >&2; exit 1 ;;
esac
apt-get -o Acquire::Retries=0 install --yes --no-install-recommends "apt=$apt_fix" "$apt_library=$apt_fix"
# Digest-pinned base images still need their distribution's signed security fixes.
# Upgrade within the existing release without removing packages or changing DB major versions.
apt-get -o Acquire::Retries=0 upgrade --yes --no-install-recommends
rm -rf /var/lib/apt/lists/*
