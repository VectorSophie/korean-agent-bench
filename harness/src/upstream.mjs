import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The ONE place the harness locates upstage-cli. The CLI is a pinned git
// submodule at vendor/upstage-cli (ADR 0002); the harness reuses its agent
// loop, tool registry, policy engine, sandbox flags and model adapters rather
// than re-implementing them. There is deliberately no env override: static
// imports (sandbox/docker.mjs, tests) also resolve into the submodule, and an
// override that moved only the dynamic loaders would silently mix two CLI
// versions in one run. To evaluate a different CLI revision, move the pin.
export const CLI_ROOT = resolve(fileURLToPath(import.meta.url), "../../../vendor/upstage-cli");
export const CLI_SRC = resolve(CLI_ROOT, "src");

function assertCliPresent() {
  if (!existsSync(resolve(CLI_SRC, "agent/loop.mjs"))) {
    throw new Error(
      `upstage-cli not found at ${CLI_ROOT}. Initialize the pinned submodule:\n` +
        "  git submodule update --init vendor/upstage-cli\n" +
        "  (cd vendor/upstage-cli && bun install --frozen-lockfile)"
    );
  }
}

export async function importFromCli(relPath) {
  assertCliPresent();
  return import(pathToFileURL(resolve(CLI_SRC, relPath)).href);
}
