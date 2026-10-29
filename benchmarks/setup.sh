#!/usr/bin/env bash
# Creates isolated, pinned Python environments for the external benchmarks'
# OFFICIAL tooling (ADR 0009). CPU only: torch comes from the CPU wheel index,
# so nothing CUDA is installed. Output: .cache/venv-bfcl, .cache/venv-swebench
# (gitignored). Usage: benchmarks/setup.sh [bfcl|swebench|all]
set -euo pipefail
cd "$(dirname "$0")/.."
PY=${PYTHON:-python3}
BFCL_EVAL_VERSION=2026.3.23     # = gorilla 6ea57973c7a6 (datasets/registry.json)
SWEBENCH_VERSION=5.0.2          # = SWE-bench/SWE-bench 490635b2e9e7
BFCL_EVAL_WHEEL_SHA256=3bb6dfa5f0c68ad403c9ec50b00db2bb3b4cc9b38ab1ff33f48fe30d853d3a0a
SWEBENCH_WHEEL_SHA256=b7f0416a1e686eca22c2f749b5f816685a202835032f6683080e2b53545bbb62
TORCH_CPU_INDEX=https://download.pytorch.org/whl/cpu

# Download the official package wheel, verify it against the pinned sha256,
# install from the verified file. Dependencies resolve normally (see freeze.txt).
verified_wheel() { # venv dist version sha256 -> path
  local dir=".cache/wheels"; mkdir -p "$dir"
  ".cache/$1/bin/pip" download -q --no-deps "$2==$3" -d "$dir" >&2
  local whl; whl=$(ls "$dir"/"${2//-/_}"-"$3"-*.whl)
  if ! echo "$4  $whl" | sha256sum -c --quiet - >&2; then
    echo "ABORT: sha256 mismatch for $whl (expected $4)" >&2; return 1
  fi
  echo "$whl"
}

mk() { [ -x ".cache/$1/bin/python" ] || "$PY" -m venv ".cache/$1"; ".cache/$1/bin/pip" install -q --upgrade pip; }

if [[ "${1:-all}" =~ ^(bfcl|all)$ ]]; then
  mk venv-bfcl
  # bfcl-eval depends on sentence-transformers -> torch; force the CPU wheel.
  .cache/venv-bfcl/bin/pip install -q torch --index-url "$TORCH_CPU_INDEX"
  whl=$(verified_wheel venv-bfcl bfcl-eval "$BFCL_EVAL_VERSION" "$BFCL_EVAL_WHEEL_SHA256")
  .cache/venv-bfcl/bin/pip install -q "$whl"
  # qwen-agent 0.0.34 (bfcl-eval's unpinned dependency; also the release current
  # at bfcl-eval 2026.3.23) imports soundfile without declaring it, so
  # `bfcl` fails at import without this. Environment fix only; no BFCL change.
  .cache/venv-bfcl/bin/pip install -q "soundfile==0.13.1"
  .cache/venv-bfcl/bin/pip freeze --all > .cache/venv-bfcl/freeze.txt
  echo "bfcl-eval $(.cache/venv-bfcl/bin/python -c 'import importlib.metadata as m; print(m.version("bfcl-eval"))') ready"
fi
if [[ "${1:-all}" =~ ^(swebench|all)$ ]]; then
  mk venv-swebench
  whl=$(verified_wheel venv-swebench swebench "$SWEBENCH_VERSION" "$SWEBENCH_WHEEL_SHA256")
  .cache/venv-swebench/bin/pip install -q "$whl"
  .cache/venv-swebench/bin/pip freeze --all > .cache/venv-swebench/freeze.txt
  echo "swebench $(.cache/venv-swebench/bin/python -c 'import importlib.metadata as m; print(m.version("swebench"))') ready"
fi
