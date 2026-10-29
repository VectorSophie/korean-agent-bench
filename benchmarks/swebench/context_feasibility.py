#!/usr/bin/env python3
"""Preregistered context-feasibility report for the SWE-bench subset (ADR 0009).

    .cache/venv-bfcl/bin/python benchmarks/swebench/context_feasibility.py

Inputs: datasets/swe-bench-verified/subset-v1.json, the local instance export,
the captured initial agent requests (capture_initial_request.mjs), each model's
own tokenizer + chat template from the local HF cache (read-only,
local_files_only; nothing is downloaded), and harness/src/agent/local-models.mjs.

Per (instance, model) it renders the agent's real first request with the
model's chat template and counts tokens:
  lowerBound = system prompt + empty-repository context block + tools + issue prompt
  upperBound = lowerBound + the CLI's repository-context cap in characters
               (23,592 = floor(65536 * 4 * 0.09); characters >= tokens for ASCII)
and classifies against contextLimit - maxOutputTokens (the frozen envelope):
  fits                  upperBound fits
  cannot_fit            lowerBound already exceeds  (certain)
  depends_on_context    in between; decided by the real repository context at run time
No instance is removed: infeasible instances stay in the denominator and are
reported separately (ADR 0009). Output: datasets/swe-bench-verified/context-feasibility-v1.json
"""
import collections
import json
import os
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[2]
HUB = pathlib.Path(os.getenv("KAB_HF_HUB", "/data/jackb/krasis/huggingface/hub"))
REQS = ROOT / ".cache/swebench/initial-requests"
OUT = ROOT / "datasets/swe-bench-verified/context-feasibility-v1.json"
REPO_CONTEXT_CAP_CHARS = 23592  # upstage-cli context-builder: floor(65536 * 4 * 0.09); 65536 = its fallback for unknown model ids
PLACE = {"<<<KAB_REPO>>>": "repo", "<<<KAB_BASE_COMMIT>>>": "base_commit", "<<<KAB_ISSUE>>>": "problem_statement"}


def local_models():
    js = "import('./harness/src/agent/local-models.mjs').then(m => console.log(JSON.stringify(m.LOCAL_MODELS)))"
    return json.loads(subprocess.run(["node", "-e", js], cwd=ROOT, capture_output=True, text=True, check=True).stdout)


def snapshot(cfg):
    repo = cfg["provenance"]["hfRepo"].replace("/", "--")
    return HUB / f"models--{repo}" / "snapshots" / cfg["provenance"]["revision"]


def main():
    from transformers import AutoTokenizer
    os.environ["HF_HUB_OFFLINE"] = "1"
    models = local_models()
    subset = json.loads((ROOT / "datasets/swe-bench-verified/subset-v1.json").read_text())
    rows = {}
    for line in next((ROOT / ".cache/swebench").glob("*/instances.jsonl")).read_text().splitlines():
        r = json.loads(line)
        rows[r["instance_id"]] = r
    per_model, table = {}, collections.defaultdict(dict)
    for key, cfg in models.items():
        # Never execute repository code: the generic fast tokenizer from
        # tokenizer.json + the snapshot's chat template is what is counted.
        tok = AutoTokenizer.from_pretrained(snapshot(cfg), local_files_only=True, trust_remote_code=False)
        req = json.loads((REQS / f"{key}.json").read_text())
        kwargs = cfg.get("chatTemplateKwargs") or {}
        budget = cfg["contextLimit"] - cfg["maxOutputTokens"]
        per_model[key] = {"contextLimit": cfg["contextLimit"], "maxOutputTokens": cfg["maxOutputTokens"], "inputBudget": budget,
                          "tokenizer": f"{cfg['provenance']['hfRepo']}@{cfg['provenance']['revision']}", "tokenizerClass": type(tok).__name__,
                          "chatTemplateKwargs": kwargs}
        for iid in subset["instance_ids"]:
            inst = rows[iid]
            msgs = []
            for m in req["messages"]:
                c = m["content"]
                for ph, field in PLACE.items():
                    c = c.replace(ph, inst[field])
                msgs.append({"role": m["role"], "content": c})
            ids = tok.apply_chat_template(msgs, tools=req.get("tools"), add_generation_prompt=True, tokenize=True, **kwargs)
            n = len(ids["input_ids"]) if isinstance(ids, dict) or hasattr(ids, "keys") else len(ids)
            upper = n + REPO_CONTEXT_CAP_CHARS
            cls = "fits" if upper <= budget else ("cannot_fit" if n > budget else "depends_on_context")
            table[iid][key] = {"lowerBound": n, "upperBound": upper, "class": cls}
    summary = {k: dict(collections.Counter(table[i][k]["class"] for i in table)) for k in models}
    out = {
        "kind": "swebench-context-feasibility",
        "preregistered": "Computed 2026-10-29 before any model run on this subset; classification never uses model output.",
        "subset": subset["subset"], "promptTemplateSha256": json.loads((REQS / "summary.json").read_text())["promptTemplateSha256"],
        "method": __doc__.split("Per (instance, model)")[1].split("No instance")[0].strip(),
        "repositoryContextCapChars": REPO_CONTEXT_CAP_CHARS,
        "knownIssue": "upstage-cli (pinned 7380ef6) has no capability entry for these served model ids and uses its 65,536-token fallback, so the repository-context cap and its own context management do not reflect the 8K/16K validated windows. See docs/STATUS.md.",
        "policy": "Instances are never removed for infeasibility. Results report resolved / unresolved / infeasible (context) / infrastructure error separately per model.",
        "models": per_model, "summary": summary, "instances": table,
    }
    OUT.write_text(json.dumps(out, indent=1) + "\n")
    print(json.dumps(summary, indent=1))
    for k in models:
        lows = sorted(table[i][k]["lowerBound"] for i in table)
        print(f"{k:15} lowerBound tokens min/median/max = {lows[0]}/{lows[len(lows)//2]}/{lows[-1]}  inputBudget={per_model[k]['inputBudget']}")


if __name__ == "__main__":
    main()
