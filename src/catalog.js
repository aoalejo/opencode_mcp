import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/** List configured providers/credentials (names only, never secrets). */
export async function listProviders() {
  const { stdout } = await execFileAsync("opencode", ["auth", "list"]);
  const clean = stripAnsi(stdout);
  const names = [];
  for (const line of clean.split("\n")) {
    const m = line.match(/●\s+(.+?)\s+api\s*$/);
    if (m) names.push(m[1].trim());
  }
  return names;
}

/** Whether the OpenCode Go subscription credential is configured on this machine. */
export async function hasGoSubscription() {
  return (await listProviders()).includes("OpenCode Go");
}

/** List "provider/model" ids, optionally filtered to one provider. */
export async function listModels(provider) {
  const args = ["models"];
  if (provider) args.push(provider);
  const { stdout } = await execFileAsync("opencode", args);
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Fetch verbose metadata (cost, context window, capabilities...) for every
 * model under a provider in one CLI call. Output is a header line
 * "provider/model" followed by a pretty-printed JSON blob, repeated per
 * model — split into blocks by brace-depth tracking since there's no
 * top-level array/newline-delimited JSON option.
 */
export async function listModelsVerbose(provider) {
  const { stdout } = await execFileAsync("opencode", ["models", provider, "--verbose"]);
  const lines = stdout.split("\n");
  const entries = [];
  let i = 0;
  while (i < lines.length) {
    const header = lines[i].trim();
    i++;
    if (!header.startsWith(`${provider}/`)) continue;
    if (i >= lines.length || !lines[i].trim().startsWith("{")) continue;

    let depth = 0;
    const jsonLines = [];
    do {
      const line = lines[i];
      for (const ch of line) {
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
      }
      jsonLines.push(line);
      i++;
    } while (depth > 0 && i < lines.length);

    try {
      entries.push({ model: header, info: JSON.parse(jsonLines.join("\n")) });
    } catch {
      // malformed block; skip rather than abort the whole listing
    }
  }
  return entries;
}

/**
 * Fetch verbose metadata for a single "provider/model" id. Convenience
 * wrapper over listModelsVerbose for the common one-model lookup.
 */
export async function modelInfo(providerSlashModel) {
  const [provider, ...rest] = providerSlashModel.split("/");
  const modelId = rest.join("/");
  if (!provider || !modelId) {
    throw new Error('model must be in "provider/model" form, e.g. "opencode/big-pickle"');
  }
  const entries = await listModelsVerbose(provider);
  const match = entries.find((e) => e.model === `${provider}/${modelId}`);
  return match ? match.info : null;
}
