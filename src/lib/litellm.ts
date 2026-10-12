import type { AiModel, AiProvider } from "./ai-models.ts";

// Models served by a self-hosted LiteLLM proxy are stored as "litellm/<name>",
// where <name> is the proxy's model_name. The prefix keeps them apart from the
// OpenRouter and Groq ids, since the proxy can expose any upstream model.
export const LITELLM_MODEL_PREFIX = "litellm/";

export function isLitellmModel(modelId: string): boolean {
  return modelId.startsWith(LITELLM_MODEL_PREFIX);
}

export function litellmModelId(name: string): string {
  return `${LITELLM_MODEL_PREFIX}${name}`;
}

export function litellmModelName(modelId: string): string {
  return isLitellmModel(modelId) ? modelId.slice(LITELLM_MODEL_PREFIX.length) : modelId;
}

// The proxy serves its OpenAI routes with and without /v1, so accept either
// spelling and keep a path prefix such as https://host/litellm. Returns "" for
// anything that is not an http(s) URL.
export function normalizeLitellmUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return "";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  if (url.username || url.password) return "";
  const path = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  return `${url.origin}${path}`;
}

export function litellmChatRequest(
  baseUrl: string,
  key: string,
  modelId: string,
  body: Record<string, unknown>,
): { url: string; init: RequestInit } {
  const root = normalizeLitellmUrl(baseUrl);
  if (!root) throw new Error("Set your LiteLLM proxy URL in Settings › AI search.");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key.trim()) headers.Authorization = `Bearer ${key.trim()}`;
  return {
    url: `${root}/v1/chat/completions`,
    init: {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, model: litellmModelName(modelId) }),
    },
  };
}

// LiteLLM reports the upstream as litellm_provider; map the common ones to the
// existing logos so a proxied Claude still shows the Anthropic mark.
const FAMILY_BY_LITELLM_PROVIDER: Record<string, AiProvider> = {
  openai: "openai",
  azure: "openai",
  text_completion_openai: "openai",
  anthropic: "anthropic",
  bedrock: "anthropic",
  gemini: "gemini",
  vertex_ai: "gemini",
  "vertex_ai-language-models": "gemini",
  mistral: "mistral",
  deepseek: "deepseek",
  xai: "xai",
  groq: "groq",
  moonshot: "moonshot",
  dashscope: "qwen",
};

type ModelInfoEntry = {
  model_name?: string;
  model_info?: { mode?: string | null; litellm_provider?: string | null } | null;
};

function headersFor(key: string): Record<string, string> {
  return key.trim() ? { Authorization: `Bearer ${key.trim()}` } : {};
}

export const LITELLM_DISCOVERY_TIMEOUT_MS = 10_000;

// Lists the chat models the proxy serves for this key. /model/info carries the
// mode and upstream provider, so embedding, image and audio deployments are
// left out; keys that cannot read it fall back to the plain /v1/models list.
// Gives up after timeoutMs so a host that never answers does not load forever.
export async function fetchLitellmModels(
  baseUrl: string,
  key: string,
  fetchImpl: typeof fetch = fetch,
  {
    signal,
    timeoutMs = LITELLM_DISCOVERY_TIMEOUT_MS,
  }: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<AiModel[]> {
  const root = normalizeLitellmUrl(baseUrl);
  if (!root) throw new Error("Enter an http(s) proxy URL, for example http://localhost:4000.");

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await discoverModels(root, key, fetchImpl, controller.signal);
  } catch (e) {
    if (timedOut) {
      throw new Error(
        `LiteLLM proxy did not respond within ${Math.round(timeoutMs / 1000)} seconds.`,
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function discoverModels(
  root: string,
  key: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<AiModel[]> {
  const seen = new Set<string>();
  const models: AiModel[] = [];
  const add = (name: string, family?: AiProvider) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    models.push({ id: litellmModelId(name), label: name, provider: "litellm", family });
  };

  const info = await fetchImpl(`${root}/model/info`, { headers: headersFor(key), signal });
  if (info.ok) {
    const data = (await info.json()) as { data?: ModelInfoEntry[] };
    for (const entry of data.data ?? []) {
      const mode = entry.model_info?.mode;
      if (mode && mode !== "chat" && mode !== "responses") continue;
      const upstream = entry.model_info?.litellm_provider ?? "";
      add(entry.model_name ?? "", FAMILY_BY_LITELLM_PROVIDER[upstream]);
    }
    return models;
  }
  if (info.status !== 401 && info.status !== 403 && info.status !== 404) {
    throw new Error(`LiteLLM proxy returned ${info.status} for /model/info.`);
  }

  const list = await fetchImpl(`${root}/v1/models`, { headers: headersFor(key), signal });
  if (!list.ok) {
    throw new Error(
      list.status === 401 || list.status === 403
        ? "LiteLLM rejected the key. Use a virtual key or the proxy master key."
        : `LiteLLM proxy returned ${list.status} for /v1/models.`,
    );
  }
  const data = (await list.json()) as { data?: Array<{ id?: string }> };
  for (const entry of data.data ?? []) add(entry.id ?? "");
  return models;
}
