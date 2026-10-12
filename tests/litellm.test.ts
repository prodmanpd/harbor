// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import { keyForProvider, modelLabelFor, providerForModel } from "../src/lib/ai-models.ts";
import {
  fetchLitellmModels,
  litellmChatRequest,
  litellmModelId,
  normalizeLitellmUrl,
} from "../src/lib/litellm.ts";

type Call = { url: string; auth: string | null };

function fakeFetch(routes: Record<string, { status: number; body?: unknown }>, calls: Call[] = []) {
  return (async (input: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), auth: headers.get("Authorization") });
    const route = routes[String(input)] ?? { status: 404 };
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status });
  }) as typeof fetch;
}

test("normalizes proxy URLs to the root and keeps a path prefix", () => {
  assert.equal(normalizeLitellmUrl("http://localhost:4000"), "http://localhost:4000");
  assert.equal(normalizeLitellmUrl(" http://localhost:4000/v1/ "), "http://localhost:4000");
  assert.equal(
    normalizeLitellmUrl("https://gw.example.com/litellm//"),
    "https://gw.example.com/litellm",
  );
  assert.equal(normalizeLitellmUrl("ftp://proxy:4000"), "");
  assert.equal(normalizeLitellmUrl("https://user:secret@proxy"), "");
  assert.equal(normalizeLitellmUrl("not a url"), "");
});

test("routes litellm/ models to the LiteLLM provider without changing existing routing", () => {
  assert.equal(providerForModel("litellm/claude-sonnet-4-6"), "litellm");
  assert.equal(providerForModel("litellm/llama-3.1-8b-instant"), "litellm");
  assert.equal(providerForModel("llama-3.1-8b-instant"), "groq");
  assert.equal(providerForModel("openai/gpt-4o"), "openai");
  assert.equal(modelLabelFor("litellm/gpt-4.1-mini"), "gpt-4.1-mini");
  const settings = {
    aiSearchKey: "or",
    aiGroqKey: "gsk",
    aiLitellmUrl: "http://localhost:4000",
    aiLitellmKey: "sk-proxy",
  };
  assert.equal(keyForProvider(settings, "litellm"), "sk-proxy");
  assert.equal(keyForProvider(settings, "groq"), "gsk");
  assert.equal(keyForProvider(settings, "openai"), "or");
});

test("builds the chat request against the proxy with the bare model name", () => {
  const { url, init } = litellmChatRequest(
    "http://localhost:4000/v1",
    "sk-proxy",
    "litellm/gpt-4.1-mini",
    {
      temperature: 0.4,
      messages: [{ role: "user", content: "hi" }],
    },
  );
  assert.equal(url, "http://localhost:4000/v1/chat/completions");
  assert.equal(new Headers(init.headers).get("Authorization"), "Bearer sk-proxy");
  assert.equal(new Headers(init.headers).get("HTTP-Referer"), null);
  const body = JSON.parse(String(init.body));
  assert.equal(body.model, "gpt-4.1-mini");
  assert.equal(body.temperature, 0.4);
  assert.throws(() => litellmChatRequest("", "sk", "litellm/x", {}), /proxy URL/);
});

test("lists only chat models from /model/info, deduplicated, with upstream logos", async () => {
  const calls: Call[] = [];
  const models = await fetchLitellmModels(
    "http://localhost:4000/v1",
    "sk-proxy",
    fakeFetch(
      {
        "http://localhost:4000/model/info": {
          status: 200,
          body: {
            data: [
              {
                model_name: "gpt-4.1-mini",
                model_info: { mode: "chat", litellm_provider: "azure" },
              },
              {
                model_name: "gpt-4.1-mini",
                model_info: { mode: "chat", litellm_provider: "openai" },
              },
              { model_name: "claude", model_info: { mode: "chat", litellm_provider: "bedrock" } },
              { model_name: "emb-small", model_info: { mode: "embedding" } },
              { model_name: "imagen", model_info: { mode: "image_generation" } },
              { model_name: "custom-local", model_info: null },
            ],
          },
        },
      },
      calls,
    ),
  );
  assert.deepEqual(
    models.map((m) => [m.id, m.label, m.provider, m.family]),
    [
      [litellmModelId("gpt-4.1-mini"), "gpt-4.1-mini", "litellm", "openai"],
      [litellmModelId("claude"), "claude", "litellm", "anthropic"],
      [litellmModelId("custom-local"), "custom-local", "litellm", undefined],
    ],
  );
  assert.deepEqual(calls, [{ url: "http://localhost:4000/model/info", auth: "Bearer sk-proxy" }]);
});

test("falls back to /v1/models when the key cannot read /model/info", async () => {
  const models = await fetchLitellmModels(
    "http://localhost:4000",
    "sk-scoped",
    fakeFetch({
      "http://localhost:4000/model/info": { status: 403 },
      "http://localhost:4000/v1/models": {
        status: 200,
        body: { data: [{ id: "gpt-4.1-mini" }, { id: "gemini-2.5-flash" }] },
      },
    }),
  );
  assert.deepEqual(
    models.map((m) => m.id),
    ["litellm/gpt-4.1-mini", "litellm/gemini-2.5-flash"],
  );
});

test("reports a rejected key and proxy errors instead of an empty list", async () => {
  await assert.rejects(
    fetchLitellmModels(
      "http://localhost:4000",
      "bad",
      fakeFetch({
        "http://localhost:4000/model/info": { status: 401 },
        "http://localhost:4000/v1/models": { status: 401 },
      }),
    ),
    /rejected the key/,
  );
  await assert.rejects(
    fetchLitellmModels(
      "http://localhost:4000",
      "sk",
      fakeFetch({ "http://localhost:4000/model/info": { status: 500 } }),
    ),
    /returned 500/,
  );
  await assert.rejects(fetchLitellmModels("ftp://x", "sk", fakeFetch({})), /http\(s\) proxy URL/);
});

test("gives up on a proxy that never answers and honours an external abort", async () => {
  const hanging = ((_input: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as typeof fetch;
  await assert.rejects(
    fetchLitellmModels("http://localhost:4000", "sk", hanging, { timeoutMs: 20 }),
    /did not respond within/,
  );
  const controller = new AbortController();
  const pending = fetchLitellmModels("http://localhost:4000", "sk", hanging, {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, /aborted/);
});
