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
    bound to the model's own endpoint, (b) chat_template_kwargs as extra_body
    when models.json declares them, (c) max_tokens = the model's validated
    output ceiling (BFCL sends none), (d) reasoning kept out of the chat
    history under both vLLM field names (upstream's
    _add_reasoning_content_if_available_FC semantics), (e) a per-response
    diagnostics line (finish_reason, usage, empty output) in
    $BFCL_PROJECT_ROOT/kab-diagnostics.jsonl. Prompts, temperature, tool
    compilation, response decoding and all scoring stay upstream.
"""
import json
import os
import pathlib
import sys
import threading

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

    current = threading.local()
    diag_lock = threading.Lock()
    diag_path = pathlib.Path(os.environ["BFCL_PROJECT_ROOT"]) / "kab-diagnostics.jsonl"

    class KabLocalFCHandler(OpenAICompletionsHandler):
        def __init__(self, model_name, temperature, registry_name, is_fc_model, **kwargs):
            super().__init__(model_name, temperature, registry_name, is_fc_model, **kwargs)
            entry = MODELS[registry_name]
            self.client = OpenAI(base_url=resolve_base_url(entry), api_key=os.getenv("LOCAL_MODEL_API_KEY", "EMPTY"))
            self._extra_body = {"chat_template_kwargs": entry["chatTemplateKwargs"]} if entry["chatTemplateKwargs"] else None
            self._max_tokens = entry.get("maxOutputTokens")

        def inference(self, test_entry, *args, **kwargs):
            current.id = test_entry.get("id")
            current.turn = 0
            return super().inference(test_entry, *args, **kwargs)

        def generate_with_backoff(self, **kwargs):
            if self._extra_body:
                kwargs["extra_body"] = self._extra_body
            if self._max_tokens:
                kwargs["max_tokens"] = self._max_tokens
            return super().generate_with_backoff(**kwargs)

        def _parse_query_response_FC(self, api_response):
            data = super()._parse_query_response_FC(api_response)
            choice = api_response.choices[0]
            message = choice.message
            extra = getattr(message, "model_extra", None) or {}
            reasoning = extra.get("reasoning") or extra.get("reasoning_content") or getattr(message, "reasoning_content", None)
            # Upstream semantics (_add_reasoning_content_if_available_FC), applied to
            # both field names vLLM may use: keep tool calls and content in the chat
            # history, never the reasoning; log the reasoning to the result file.
            history = {"role": "assistant", "content": message.content}
            if getattr(message, "tool_calls", None):
                history["tool_calls"] = [{"id": tc.id, "type": tc.type, "function": {"name": tc.function.name, "arguments": tc.function.arguments}} for tc in message.tool_calls]
            data["model_responses_message_for_chat_history"] = history
            if reasoning:
                data["reasoning_content"] = reasoning
            usage = getattr(api_response, "usage", None)
            rec = {"id": getattr(current, "id", None), "turn": getattr(current, "turn", 0), "finish_reason": choice.finish_reason,
                   "tool_calls": len(message.tool_calls or []), "content_chars": len(message.content or ""),
                   "reasoning_chars": len(reasoning or ""),
                   "prompt_tokens": getattr(usage, "prompt_tokens", None), "completion_tokens": getattr(usage, "completion_tokens", None)}
            current.turn = getattr(current, "turn", 0) + 1
            with diag_lock, open(diag_path, "a") as f:
                f.write(json.dumps(rec) + "\n")
            return data

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
