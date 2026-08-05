import { createOllamaClient, type OllamaClient } from "../ai/ollama.js";
import {
  loadConfig,
  saveConfigAtomic,
  type Exposure,
  type RockyConfigV1,
} from "../core/config.js";
import { detail, say } from "../ui/rocky.js";

export interface ModelDependencies {
  ollama: OllamaClient;
  loadConfig: typeof loadConfig;
  saveConfigAtomic: typeof saveConfigAtomic;
}

interface UseRequest {
  model: string;
  exposure: Exposure;
}

const TINY = { label: "Tiny", name: "qwen3:0.6b-q4_K_M", size: "523 MB" } as const;
const BALANCED = { label: "Balanced", name: "qwen3.5:2b-q4_K_M", size: "1.9 GB" } as const;

function defaultDependencies(): ModelDependencies {
  return { ollama: createOllamaClient(), loadConfig, saveConfigAtomic };
}

function usage(): number {
  say("model needs status, use, or off. which one, question");
  detail("usage: rocky model status | use [--exposure sanitized|raw] <installed-model> | off");
  return 2;
}

function useRequest(argv: readonly string[]): UseRequest | undefined {
  if (argv.length === 1 && argv[0] !== undefined && argv[0].length > 0 && !argv[0].startsWith("--")) {
    return { model: argv[0], exposure: "sanitized" };
  }
  if (
    argv.length === 3 && argv[0] === "--exposure" &&
    (argv[1] === "sanitized" || argv[1] === "raw") &&
    argv[2] !== undefined && argv[2].length > 0 && !argv[2].startsWith("--")
  ) {
    return { model: argv[2], exposure: argv[1] };
  }
  return undefined;
}

function configurationFailure(path: string, message: string): number {
  say("configuration is broken. do not overwrite. bad bad.");
  detail(`AI config ${message}: ${path}`);
  return 1;
}

function readConfiguration(deps: ModelDependencies): ReturnType<typeof loadConfig> | undefined {
  try {
    return deps.loadConfig();
  } catch {
    say("configuration not available. memory still works.");
    detail("AI config unavailable");
    return undefined;
  }
}

function printChoices(): void {
  say("no installed model. pull one yourself. then use it. good good.");
  detail(`${TINY.label}: ${TINY.name} (${TINY.size}) — ranking and semantic act`);
  detail(`${BALANCED.label}: ${BALANCED.name} (${BALANCED.size}) — stronger technical interpretation`);
  detail("download size is not peak RAM. runtime, KV cache, context, and platform can use more.");
  detail(`ollama pull ${TINY.name}`);
  detail(`ollama pull ${BALANCED.name}`);
}

async function useModel(request: UseRequest, deps: ModelDependencies): Promise<number> {
  const current = readConfiguration(deps);
  if (current === undefined) return 1;
  if (current.status === "invalid") return configurationFailure(current.path, "invalid");

  let installed;
  try {
    installed = await deps.ollama.listInstalledModels();
  } catch {
    say("Ollama not available. memory still works.");
    detail("Ollama unavailable while listing installed models");
    return 1;
  }

  if (!installed.some((candidate) => candidate.name === request.model)) {
    if (installed.length === 0) printChoices();
    else {
      say("requested model not installed. pull it yourself. then use it.");
      detail(`ollama pull ${request.model}`);
    }
    return 1;
  }

  if (request.exposure === "raw") {
    detail("raw exposure sends unredacted recall evidence to local Ollama.");
  }

  let probe;
  try {
    probe = await deps.ollama.probeModel(request.model);
  } catch {
    say("model probe not work. configuration stays same. bad bad.");
    detail(`Ollama probe failed: ${request.model}`);
    return 1;
  }
  if (!probe.supported) {
    say("model probe not work. configuration stays same. bad bad.");
    detail(`Ollama probe unsupported: ${request.model}`);
    return 1;
  }

  const config: RockyConfigV1 = {
    version: 1,
    ai: { enabled: true, provider: "ollama", model: request.model, exposure: request.exposure },
  };
  try {
    deps.saveConfigAtomic(config);
  } catch {
    say("configuration not saved. memory still works. bad bad.");
    detail(`AI config could not save: ${current.path}`);
    return 1;
  }

  say("small model configured. memory still works.");
  detail(`AI: enabled (${request.model}, ${request.exposure})`);
  return 0;
}

export async function model(argv: readonly string[], dependencies?: ModelDependencies): Promise<number> {
  const deps = dependencies ?? defaultDependencies();
  const [command, ...rest] = argv;

  switch (command) {
    case "status": {
      if (rest.length !== 0) return usage();
      const current = readConfiguration(deps);
      if (current === undefined) return 1;
      if (current.status === "invalid") return configurationFailure(current.path, "invalid");
      if (!current.config.ai.enabled) {
        say("small model sleeps. memory still works.");
        detail(`AI: disabled (${current.status === "missing" ? "config missing: " : ""}${current.path})`);
        return 0;
      }
      say("small model configured. memory still works.");
      detail(`AI: enabled (${current.config.ai.model}, ${current.config.ai.exposure}, ${current.path})`);
      return 0;
    }
    case "off": {
      if (rest.length !== 0) return usage();
      const current = readConfiguration(deps);
      if (current === undefined) return 1;
      if (current.status === "invalid") return configurationFailure(current.path, "invalid");
      try {
        deps.saveConfigAtomic({ version: 1, ai: { enabled: false } });
      } catch {
        say("configuration not saved. memory still works. bad bad.");
        detail(`AI config could not save: ${current.path}`);
        return 1;
      }
      say("small model sleeps. memory still works.");
      detail(`AI: disabled (${current.path})`);
      return 0;
    }
    case "use": {
      const request = useRequest(rest);
      return request === undefined ? usage() : useModel(request, deps);
    }
    default:
      return usage();
  }
}
