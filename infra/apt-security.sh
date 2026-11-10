#!/bin/sh
set -eu
# CVE-2026-109518: disable retries while updating the vulnerable base APT,
# then install the signed, exact security fix before any other package operation.
apt-get -o Acquire::Retries=0 update
apt-get -o Acquire::Retries=0 install --yes --no-install-recommends apt=2.6.2 libapt-pkg6.0=2.6.2
rm -rf /var/lib/apt/lists/*
