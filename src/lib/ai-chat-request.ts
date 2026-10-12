import { DEFAULT_AI_MODEL, migrateModelId, providerForModel } from "./ai-models.ts";
import { isLitellmModel, litellmChatRequest } from "./litellm.ts";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export type ChatEndpoint = "openrouter" | "groq" | "litellm";

// Title search routes each model to the service that serves it.
export function chatEndpointForModel(model: string): ChatEndpoint {
  const provider = providerForModel(model);
  if (provider === "litellm") return "litellm";
  return provider === "groq" ? "groq" : "openrouter";
}

// Episode search has only ever called OpenRouter; LiteLLM models go to the
// user's proxy, everything else keeps its existing route.
export function episodeChatEndpoint(model: string): ChatEndpoint {
  return isLitellmModel(model) ? "litellm" : "openrouter";
}

export type EpisodeAiSettings = {
  aiSearchKey: string;
  aiLitellmUrl: string;
  aiLitellmKey: string;
  aiSearchModel: string;
};

export function episodeAiKey(settings: EpisodeAiSettings): string {
  return episodeChatEndpoint(settings.aiSearchModel) === "litellm"
    ? settings.aiLitellmKey
    : settings.aiSearchKey;
}

export function episodeAiReady(settings: EpisodeAiSettings): boolean {
  return episodeChatEndpoint(settings.aiSearchModel) === "litellm"
    ? Boolean(settings.aiLitellmUrl.trim())
    : Boolean(settings.aiSearchKey.trim());
}

export function buildChatRequest(
  endpoint: ChatEndpoint,
  key: string,
  model: string,
  body: Record<string, unknown>,
  litellmUrl = "",
): { url: string; init: RequestInit } {
  if (endpoint === "litellm") return litellmChatRequest(litellmUrl, key, model, body);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key.trim()}`,
    "Content-Type": "application/json",
  };
  if (endpoint === "openrouter") {
    headers["HTTP-Referer"] = "https://harbor.site";
    headers["X-Title"] = "Harbor";
  }
  return {
    url: endpoint === "groq" ? GROQ_URL : OPENROUTER_URL,
    init: {
      method: "POST",
      headers,
      body: JSON.stringify({ model: migrateModelId(model.trim()) || DEFAULT_AI_MODEL, ...body }),
    },
  };
}
