#!/usr/bin/env python3
"""Run the OFFICIAL BFCL CLI (bfcl-eval) with this project's local models registered.

    BFCL_PROJECT_ROOT=<run dir> .cache/venv-bfcl/bin/python benchmarks/bfcl/kab_bfcl.py generate \
        --model kab-kanana-FC --run-ids --skip-server-setup
    BFCL_PROJECT_ROOT=<run dir> .cache/venv-bfcl/bin/python benchmarks/bfcl/kab_bfcl.py evaluate \
        --model kab-kanana-FC --partial-eval

Everything after the subcommand is passed unchanged to `bfcl`. The only
additions are (ADR 0009):
  * model registrations from models.json, inserted into bfcl_eval's own
    MODEL_CONFIG_MAPPING (its documented "add a model" extension point);
  * KabLocalFCHandler = bfcl_eval's OpenAICompletionsHandler with (a) a client
    bound to the model's own endpoint and (b) chat_template_kwargs as
    extra_body when models.json declares them. Request construction, response
    parsing, prompts, temperature and all scoring stay upstream.
"""
import json
import os
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
MODELS = json.loads((HERE / "models.json").read_text())["models"]
# Offline validation only (validate_offline.py): extra registrations, e.g. a
# mock model served by fake_server.py, so mock numbers never appear under a
# real model's name.
if os.getenv("KAB_BFCL_EXTRA_MODELS"):
    MODELS.update(json.loads(pathlib.Path(os.environ["KAB_BFCL_EXTRA_MODELS"]).read_text()))


def resolve_base_url(entry):
    for name in entry["baseUrlEnv"]:
        if os.getenv(name):
            return os.environ[name]
    return entry["defaultBaseUrl"]


def register():
    from openai import OpenAI
    from bfcl_eval.constants.model_config import MODEL_CONFIG_MAPPING, ModelConfig
    from bfcl_eval.model_handler.api_inference.openai_completion import OpenAICompletionsHandler

    class KabLocalFCHandler(OpenAICompletionsHandler):
        def __init__(self, model_name, temperature, registry_name, is_fc_model, **kwargs):
            super().__init__(model_name, temperature, registry_name, is_fc_model, **kwargs)
            entry = MODELS[registry_name]
            self.client = OpenAI(base_url=resolve_base_url(entry), api_key=os.getenv("LOCAL_MODEL_API_KEY", "EMPTY"))
            self._extra_body = {"chat_template_kwargs": entry["chatTemplateKwargs"]} if entry["chatTemplateKwargs"] else None

        def generate_with_backoff(self, **kwargs):
            if self._extra_body:
                kwargs["extra_body"] = self._extra_body
            return super().generate_with_backoff(**kwargs)

    # OpenAICompletionsHandler.__init__ builds a default OpenAI() client before
    # ours replaces it; that constructor requires *some* key. Placeholder only
    # if none is set; requests always go through the per-model client above.
    os.environ.setdefault("OPENAI_API_KEY", "EMPTY")

    for name, entry in MODELS.items():
        MODEL_CONFIG_MAPPING[name] = ModelConfig(
            model_name=entry["servedModelName"],
            display_name=f"{entry['agent']} (local, FC) [korean-agent-bench]",
            url="https://github.com/VectorSophie/korean-agent-bench/blob/main/docs/models/README.md",
            org="korean-agent-bench (local serving)",
            license="see docs/models",
            model_handler=KabLocalFCHandler,
            input_price=None,
            output_price=None,
            is_fc_model=True,
            underscore_to_dot=True,  # OPENAI_COMPLETIONS style renames '.' to '_' in tool names
        )


def main():
    root = os.getenv("BFCL_PROJECT_ROOT")
    if not root:
        sys.exit("BFCL_PROJECT_ROOT must be set (results/scores are written there, never into site-packages)")
    pathlib.Path(root).mkdir(parents=True, exist_ok=True)
    register()
    from bfcl_eval.__main__ import cli
    cli(prog_name="bfcl", args=sys.argv[1:])


if __name__ == "__main__":
    main()
