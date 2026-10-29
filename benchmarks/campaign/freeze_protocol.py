#!/usr/bin/env python3
"""Generate the frozen main-comparison protocol (ADR 0011) from the
authoritative sources — model registry, subset files, stage split, envelope,
pinned tool versions — so nothing is transcribed by hand.

    python3 benchmarks/campaign/freeze_protocol.py protocol/main-v1.json
"""
import hashlib
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]


def sh(cmd):
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()


def node_json(expr):
    return json.loads(sh(["node", "-e", expr]))


def sha(p):
    return hashlib.sha256((ROOT / p).read_bytes()).hexdigest()


def main(out):
    models = node_json("import('./harness/src/agent/local-models.mjs').then(m => console.log(JSON.stringify(m.LOCAL_MODELS)))")
    swe = node_json("import('./harness/src/benchmarks/swebench.mjs').then(m => console.log(JSON.stringify({envelope: m.ENVELOPE, promptTemplateId: m.PROMPT_TEMPLATE_ID, promptTemplateSha256: m.PROMPT_TEMPLATE_SHA256, dataset: m.DATASET, revision: m.REVISION})))")
    bsub = json.loads((ROOT / "datasets/bfcl/subset-v1.json").read_text())
    stages = json.loads((ROOT / "datasets/swe-bench-verified/stages-v1.json").read_text())
    primary = ["kanana", "exaone", "ax", "solar-open2"]
    proto = {
        "protocol": "korean-agent-bench main comparison v1",
        "frozenOn": "2026-10-30",
        "adr": "docs/adr/0011-main-protocol-freeze.md",
        "code": {"generatedAtCommit": sh(["git", "rev-parse", "HEAD"]), "upstageCli": sh(["git", "rev-parse", "HEAD:vendor/upstage-cli"]),
                 "trees": {p: sh(["git", "rev-parse", f"HEAD:{p}"]) for p in ("harness", "benchmarks", "models/serving")}},
        "hardware": "2x NVIDIA RTX PRO 6000 Blackwell Max-Q (96 GB each, SM120), PCIe, shared machine; one model server at a time",
        "models": {"primary": primary, "notRun": {"exaone-nothink": "optional exploratory condition; not run (resources)"},
                   "config": {k: {f: models[k][f] for f in ("servedModelName", "sampling", "chatTemplateKwargs", "maxOutputTokens", "contextLimit", "contextOutputReservation", "contextCharsPerToken")}
                              | {"provenance": {f: models[k]["provenance"].get(f) for f in ("hfRepo", "revision", "quantization", "official", "servingRuntime", "servingImage", "tensorParallel", "reasoningParser", "toolCallParser", "logitsProcessor", "maxNumSeqs", "launcher")}}
                              for k in primary}},
        "bfcl": {
            "track": "official: bfcl-eval generate/evaluate (OpenAICompletionsHandler, FC) through benchmarks/bfcl/kab_bfcl.py; no upstage-cli",
            "package": "bfcl-eval==2026.3.23", "wheelSha256": "3bb6dfa5f0c68ad403c9ec50b00db2bb3b4cc9b38ab1ff33f48fe30d853d3a0a",
            "subsetFile": "datasets/bfcl/subset-v1.json", "subsetSha256": sha("datasets/bfcl/subset-v1.json"),
            "ids": {c: v["ids"] for c, v in bsub["categories"].items()}, "n": bsub["totals"]["selected"],
            "settings": {"temperature": 0.001, "maxTokens": None, "threads": 8, "evaluate": "--partial-eval", "sampling": "BFCL's own (temperature only); model generation_config defaults apply to unset parameters"},
        },
        "swebench": {
            "track": "agent-mediated: upstage-cli loop via harness (LocalModelAgent), official instance image, scored only by swebench.harness.run_evaluation",
            "dataset": swe["dataset"], "revision": swe["revision"], "parquetSha256": json.loads((ROOT / "datasets/swe-bench-verified/source.json").read_text())["sha256"],
            "evaluator": "swebench==5.0.2", "evaluatorWheelSha256": "b7f0416a1e686eca22c2f749b5f816685a202835032f6683080e2b53545bbb62",
            "subsetFile": "datasets/swe-bench-verified/subset-v1.json", "subsetSha256": sha("datasets/swe-bench-verified/subset-v1.json"),
            "stagesFile": "datasets/swe-bench-verified/stages-v1.json", "stagesSha256": sha("datasets/swe-bench-verified/stages-v1.json"),
            "ids": stages["stage1"] + stages["stage2"], "stage1": stages["stage1"], "stage2": stages["stage2"],
            "promptTemplate": {"id": swe["promptTemplateId"], "sha256": swe["promptTemplateSha256"], "hints": "not included"},
            "envelope": swe["envelope"], "concurrency": 4,
            "workspace": "single-commit snapshot of base_commit (no history)",
        },
        "attempts": {"perTask": 1, "seed": None, "deterministic": False,
                     "infrastructureRetries": "at most 2, only for independently classified infrastructure failures (transport, 5xx, timeouts; BFCL by exception type)",
                     "neverRetried": ["model output", "tool errors", "context_exhausted", "budget_exhausted", "output_truncated", "model_protocol_error"]},
        "exclusions": "None after freeze. Context-infeasible, truncated, budget-exhausted, tool-error and infrastructure-failed tasks stay in the denominator and are reported in their own columns.",
        "resources": {"dockerBudgetGB": 100, "gpuServerHoursCeiling": 36,
                      "order": "BFCL for kanana, exaone, ax, solar-open2; then SWE-bench stage 1 in the same model order; then stage 2 only if all four models completed stage 1 and the projected stage-2 cost fits the remaining ceilings (resource decision only, never results)."},
        "analysis": {
            "bfcl": "Primary (confirmatory): pooled accuracy over the 1,106 scheduled entries (unweighted; not BFCL's overall score), Wilson 95% CI; 6 pairwise exact McNemar tests on the same entries, Holm-adjusted, alpha 0.05; paired bootstrap CI of differences. Per-category accuracy exploratory; categories with n < 30 descriptive only. Sensitivity: caught inference errors and truncated outputs counted wrong.",
            "swebench": "Resolve rate over the scheduled instances of the completed stage(s), Wilson 95% CI and repository-cluster bootstrap CI; pairwise differences descriptive with paired bootstrap CIs; McNemar reported but exploratory. Solar Open 2 (8K context, unofficial NVFP4) is reported as a separately constrained arm.",
            "behaviour": "Clean completion, budget exhaustion by kind, context exhaustion, output truncation, tool calls and tool-error rate, recoverable errors and re-plans, wall-clock — descriptive, never combined into a score.",
            "noCombinedScore": True,
        },
        "interpretation": [
            "Rankings are tied to the measured benchmark and frozen workload only; no 'best overall' claim.",
            "Both benchmarks are English; no claim about Korean-language ability follows.",
            "BFCL subset results are not comparable to the public BFCL leaderboard.",
            "SWE-bench results measure each model as the engine of upstage-cli at the pinned commit, not the model in isolation.",
        ],
    }
    pathlib.Path(out).write_text(json.dumps(proto, indent=1) + "\n")
    print(f"wrote {out}: sha256 {sha(out)}")


if __name__ == "__main__":
    main(sys.argv[1])
