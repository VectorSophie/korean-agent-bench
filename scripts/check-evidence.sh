#!/usr/bin/env bash
# Disclosure guard for committed evidence (docs/audits/2026-10-29-evidence-disclosure-audit.md).
# Fails on credential-shaped strings, non-loopback http endpoints, or held-out
# identifiers in the evidence directories. Pattern-based: it cannot prove the
# absence of secrets, only catch the known shapes.
set -euo pipefail
cd "$(dirname "$0")/.."
DIRS=(models results datasets)
status=0

creds='(sk-ant-[A-Za-z0-9_-]{10,}|sk-(proj-)?[A-Za-z0-9]{32,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|hf_[A-Za-z0-9]{30,}|up_sk_[A-Za-z0-9]{6,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer [A-Za-z0-9._-]{16,})'
if grep -rnE "$creds" "${DIRS[@]}"; then echo "FAIL: credential-shaped string in evidence"; status=1; fi

# http endpoints must be loopback; public https hosts are fine.
if grep -rnoE 'http://[A-Za-z0-9.-]+' "${DIRS[@]}" | grep -vE 'http://(127\.0\.0\.1|localhost)$'; then
  echo "FAIL: non-loopback http endpoint in evidence"; status=1
fi

if grep -rnE 'hx[0-9]-[a-z]|bench-v1-holdout|holdout-pack\.public' "${DIRS[@]}"; then
  echo "FAIL: held-out identifier in evidence (ADR 0004)"; status=1
fi

[ "$status" -eq 0 ] && echo "evidence disclosure guard: OK (${DIRS[*]})"
exit "$status"
