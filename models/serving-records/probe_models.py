#!/usr/bin/env python3
"""Probe HF repos for acquisition planning. API + tiny-file reads only; no weights."""
import json, sys, traceback
from huggingface_hub import HfApi, hf_hub_download
from huggingface_hub.utils import GatedRepoError, RepositoryNotFoundError, EntryNotFoundError, RevisionNotFoundError

api = HfApi()

REPOS = [
    ("kanana-2",        "kakaocorp/kanana-2-30b-a3b-thinking-2601"),
    ("exaone-4.5-fp8",  "LGAI-EXAONE/EXAONE-4.5-33B-FP8"),
    ("exaone-4.5-bf16", "LGAI-EXAONE/EXAONE-4.5-33B"),
    ("raon-1-mini",     "KRAFTON/Raon-1-mini-preview"),
    ("raon-1-mini-nvfp4","KRAFTON/Raon-1-mini-preview-nvfp4"),
    ("ax-4.0",          "skt/A.X-4.0"),
    ("motif-3-nvfp4",   "Motif-Technologies/Motif-3-NVFP4"),
]

TINY = ["config.json", "generation_config.json", "tokenizer_config.json",
        "chat_template.jinja", "chat_template.json", "hf_quant_config.json",
        "model.safetensors.index.json", "preprocessor_config.json"]

def human(n):
    if n is None: return None
    for u in ["B","KB","MB","GB","TB"]:
        if n < 1024: return f"{n:.2f}{u}"
        n /= 1024
    return f"{n:.2f}PB"

out = {}
for key, repo in REPOS:
    rec = {"repo": repo, "status": None, "sha": None, "gated": None, "private": None,
           "total_bytes": None, "total_human": None, "n_safetensors": 0,
           "files": [], "error": None, "config": {}}
    try:
        info = api.model_info(repo, revision="main", files_metadata=True)
        rec["status"] = "accessible"
        rec["sha"] = info.sha
        rec["gated"] = getattr(info, "gated", None)
        rec["private"] = getattr(info, "private", None)
        total = 0
        safet = 0
        files = []
        for s in info.siblings:
            sz = getattr(s, "size", None)
            if sz is None and getattr(s, "lfs", None):
                sz = s.lfs.get("size") if isinstance(s.lfs, dict) else getattr(s.lfs, "size", None)
            if sz: total += sz
            if s.rfilename.endswith(".safetensors"): safet += 1
            files.append({"name": s.rfilename, "size": sz})
        rec["total_bytes"] = total
        rec["total_human"] = human(total)
        rec["n_safetensors"] = safet
        rec["files"] = sorted(files, key=lambda f: -(f["size"] or 0))
        # tiny config reads
        for fn in TINY:
            if any(f["name"] == fn for f in files):
                try:
                    p = hf_hub_download(repo, fn, revision=info.sha)
                    with open(p) as fh:
                        txt = fh.read()
                    try:
                        rec["config"][fn] = json.loads(txt)
                    except Exception:
                        rec["config"][fn] = txt[:4000]
                except Exception as e:
                    rec["config"][fn] = f"<read-failed: {type(e).__name__}>"
    except GatedRepoError as e:
        rec["status"] = "access_blocked"; rec["error"] = f"GatedRepoError: {e}"
    except RepositoryNotFoundError as e:
        rec["status"] = "not_found"; rec["error"] = f"RepositoryNotFoundError: {e}"
    except (RevisionNotFoundError, EntryNotFoundError) as e:
        rec["status"] = "revision_error"; rec["error"] = f"{type(e).__name__}: {e}"
    except Exception as e:
        rec["status"] = "error"; rec["error"] = f"{type(e).__name__}: {e}"
        rec["trace"] = traceback.format_exc()[-1500:]
    out[key] = rec
    print(f"[{key}] {repo} -> {rec['status']} sha={rec['sha']} gated={rec['gated']} size={rec['total_human']} shards={rec['n_safetensors']}", file=sys.stderr)

with open("/home/jackb/workspace/model-prep/probe_raw.json", "w") as f:
    json.dump(out, f, indent=2)
print("\nWROTE /home/jackb/workspace/model-prep/probe_raw.json", file=sys.stderr)
