import { LOCAL_MODEL_IDS } from "../../agent/local-models.mjs";
import { runServingPreflight, formatPreflight } from "../../preflight/serving.mjs";

// harness preflight --agent <local model> [--base-url URL] [--container NAME] [--json]
// Exit code: 0 reportable, 1 blocked, 2 usage error.
export async function preflightCommand(_argv, options = {}) {
  const agent = options.agent;
  if (!agent || !LOCAL_MODEL_IDS.includes(String(agent).toLowerCase())) {
    console.error(`Usage: harness preflight --agent <${LOCAL_MODEL_IDS.join("|")}> [--base-url URL] [--container NAME] [--json]`);
    process.exitCode = 2;
    return null;
  }
  const result = await runServingPreflight(String(agent).toLowerCase(), {
    baseUrl: typeof options["base-url"] === "string" ? options["base-url"] : null,
    containerName: typeof options.container === "string" ? options.container : null
  });
  console.log(options.json ? JSON.stringify(result, null, 2) : formatPreflight(result));
  process.exitCode = result.reportable ? 0 : 1;
  return result;
}
