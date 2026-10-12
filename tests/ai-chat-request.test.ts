// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import {
  buildChatRequest,
  chatEndpointForModel,
  episodeAiKey,
  episodeAiReady,
  episodeChatEndpoint,
} from "../src/lib/ai-chat-request.ts";
import { aiProviderReady, anyAiProviderReady } from "../src/lib/ai-models.ts";

const body = { temperature: 0.4, messages: [{ role: "user", content: "hi" }] };

test("title search routes each model to its own endpoint", () => {
  assert.equal(chatEndpointForModel("litellm/gpt-4.1-mini"), "litellm");
  assert.equal(chatEndpointForModel("llama-3.1-8b-instant"), "groq");
  assert.equal(chatEndpointForModel("openai/gpt-4o-mini"), "openrouter");
  assert.equal(chatEndpointForModel(""), "openrouter");
});

test("episode search sends LiteLLM models to the proxy and keeps the OpenRouter route", () => {
  assert.equal(episodeChatEndpoint("litellm/gpt-4.1-mini"), "litellm");
  assert.equal(episodeChatEndpoint("openai/gpt-4o-mini"), "openrouter");
  // Groq models have always gone to OpenRouter here; this change leaves that as is.
  assert.equal(episodeChatEndpoint("llama-3.1-8b-instant"), "openrouter");
});

test("builds LiteLLM, OpenRouter and Groq requests", () => {
  const litellm = buildChatRequest(
    "litellm",
    "",
    "litellm/gpt-4.1-mini",
    body,
    "http://localhost:4000/v1",
  );
  assert.equal(litellm.url, "http://localhost:4000/v1/chat/completions");
  assert.equal(new Headers(litellm.init.headers).get("Authorization"), null);
  assert.equal(JSON.parse(String(litellm.init.body)).model, "gpt-4.1-mini");

  const openrouter = buildChatRequest("openrouter", "or", "", body);
  assert.equal(openrouter.url, "https://openrouter.ai/api/v1/chat/completions");
  const orHeaders = new Headers(openrouter.init.headers);
  assert.equal(orHeaders.get("Authorization"), "Bearer or");
  assert.equal(orHeaders.get("X-Title"), "Harbor");
  assert.equal(JSON.parse(String(openrouter.init.body)).model, "openai/gpt-oss-20b:free");

  const groq = buildChatRequest("groq", "gsk", "llama-3.1-8b-instant", body);
  assert.equal(groq.url, "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(new Headers(groq.init.headers).get("X-Title"), null);
  assert.equal(JSON.parse(String(groq.init.body)).model, "llama-3.1-8b-instant");
});

test("a LiteLLM proxy is ready with a URL and no key; other providers need a key", () => {
  const none = { aiSearchKey: "", aiGroqKey: "", aiLitellmUrl: "", aiLitellmKey: "" };
  assert.equal(anyAiProviderReady(none), false);
  const keyless = { ...none, aiLitellmUrl: "http://localhost:4000" };
  assert.equal(aiProviderReady(keyless, "litellm"), true);
  assert.equal(aiProviderReady(keyless, "openai"), false);
  assert.equal(anyAiProviderReady(keyless), true);
  assert.equal(aiProviderReady({ ...none, aiLitellmKey: "sk" }, "litellm"), false);
  assert.equal(anyAiProviderReady({ ...none, aiGroqKey: "gsk" }), true);
  assert.equal(anyAiProviderReady({ ...none, aiSearchKey: "or" }), true);
});

test("episode search uses the LiteLLM key and URL only for LiteLLM models", () => {
  const settings = {
    aiSearchKey: "or",
    aiLitellmUrl: "http://localhost:4000",
    aiLitellmKey: "sk-proxy",
    aiSearchModel: "litellm/gpt-4.1-mini",
  };
  assert.equal(episodeAiKey(settings), "sk-proxy");
  assert.equal(episodeAiReady({ ...settings, aiSearchKey: "", aiLitellmKey: "" }), true);
  assert.equal(episodeAiReady({ ...settings, aiLitellmUrl: "" }), false);
  const openrouter = { ...settings, aiSearchModel: "openai/gpt-4o-mini" };
  assert.equal(episodeAiKey(openrouter), "or");
  assert.equal(episodeAiReady({ ...openrouter, aiSearchKey: "" }), false);
});
