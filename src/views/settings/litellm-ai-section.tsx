import { useEffect, useState } from "react";
import { useSettings } from "@/lib/settings";
import { DEFAULT as DEFAULT_SETTINGS } from "@/lib/settings/defaults";
import { useT } from "@/lib/i18n";
import type { AiModel } from "@/lib/ai-models";
import { fetchLitellmModels, isLitellmModel, normalizeLitellmUrl } from "@/lib/litellm";
import litellmLogo from "@/assets/ai-logos/litellm.png";
import { AiModelSelect } from "./ai-model-select";
import { ExtLink, KeyField } from "./shared";

// Discovery results are keyed by proxy URL and key, so a stale result is
// never shown for new settings and the loading state needs no extra render.
type Discovery = { forKey: string; models: AiModel[] } | { forKey: string; error: string | null };

export function LitellmAiSection() {
  const { settings, update } = useSettings();
  const t = useT();
  const [urlDraft, setUrlDraft] = useState(settings.aiLitellmUrl);
  const [keyDraft, setKeyDraft] = useState(settings.aiLitellmKey);
  const [keySaved, setKeySaved] = useState(false);
  const [urlInvalid, setUrlInvalid] = useState(false);
  const [discovery, setDiscovery] = useState<Discovery | null>(null);

  const url = settings.aiLitellmUrl;
  const key = settings.aiLitellmKey;
  const discoveryKey = `${url}\n${key}`;

  const commitUrl = () => {
    const normalized = normalizeLitellmUrl(urlDraft);
    if (urlDraft.trim() && !normalized) {
      setUrlInvalid(true);
      return;
    }
    setUrlInvalid(false);
    setUrlDraft(normalized);
    if (normalized !== url) update({ aiLitellmUrl: normalized });
  };

  useEffect(() => {
    if (!url) return;
    let current = true;
    const controller = new AbortController();
    fetchLitellmModels(url, key, fetch, { signal: controller.signal })
      .then((models) => {
        if (current) setDiscovery({ forKey: discoveryKey, models });
      })
      .catch((e: unknown) => {
        if (current)
          setDiscovery({ forKey: discoveryKey, error: e instanceof Error ? e.message : null });
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [url, key, discoveryKey]);

  const result = url && discovery?.forKey === discoveryKey ? discovery : null;
  const loading = Boolean(url) && !result;
  const models = result && "models" in result ? result.models : [];
  const error = urlInvalid
    ? t("Enter an http(s) proxy URL, for example http://localhost:4000.")
    : result && "error" in result
      ? (result.error ?? t("Could not reach the LiteLLM proxy."))
      : "";
  const selected = isLitellmModel(settings.aiSearchModel) ? settings.aiSearchModel : "";
  const status = error
    ? error
    : !url
      ? t("Add your proxy URL to load its models.")
      : loading
        ? t("Loading models…")
        : models.length === 1
          ? t("1 chat model available")
          : t("{count} chat models available", { count: models.length });

  return (
    <>
      <div className="flex flex-col gap-2.5">
        <label className="text-[12px] font-semibold uppercase tracking-[0.14em] text-ink-subtle">
          {t("LiteLLM proxy URL")}
        </label>
        <input
          type="text"
          value={urlDraft}
          onChange={(e) => setUrlDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitUrl();
          }}
          onBlur={commitUrl}
          placeholder="http://localhost:4000"
          spellCheck={false}
          autoComplete="off"
          className="h-11 rounded-xl border border-edge bg-canvas px-3.5 font-mono text-[13px] text-ink transition-colors focus:border-accent"
        />
        <p className="text-[13px] leading-relaxed text-ink-muted">
          Point AI search at your own{" "}
          <ExtLink href="https://docs.litellm.ai/docs/simple_proxy">LiteLLM</ExtLink> proxy to use
          any model it serves, from OpenAI and Anthropic to Bedrock, Vertex AI or a local Ollama, on
          your own keys and budgets.
        </p>
      </div>
      <KeyField
        label={t("AI Search · LiteLLM key")}
        placeholder={t("Virtual key or master key (sk-...)")}
        iconSrc={litellmLogo}
        value={keyDraft}
        onChange={setKeyDraft}
        onSave={() => {
          update({ aiLitellmKey: keyDraft.trim() });
          setKeySaved(true);
          window.setTimeout(() => setKeySaved(false), 1800);
        }}
        saved={keySaved}
        help={
          <>
            A LiteLLM virtual key scoped to the models you want Harbor to use. Leave it empty if
            your proxy runs without authentication.
          </>
        }
      />
      <div className="flex flex-col gap-1.5">
        <AiModelSelect
          value={selected}
          onChange={(v) => update({ aiSearchModel: v })}
          models={models}
          defaultModel=""
        />
        <div className="flex items-center justify-between gap-3 px-1">
          <span className={`text-[12px] ${error ? "text-red-400" : "text-ink-subtle"}`}>
            {status}
          </span>
          {url && (
            <button
              type="button"
              onClick={() => {
                setUrlDraft("");
                // A LiteLLM model cannot run without its proxy; fall back to the default model.
                update(
                  isLitellmModel(settings.aiSearchModel)
                    ? { aiLitellmUrl: "", aiSearchModel: DEFAULT_SETTINGS.aiSearchModel }
                    : { aiLitellmUrl: "" },
                );
              }}
              className="text-[12px] text-ink-muted transition-colors hover:text-ink"
            >
              {t("Forget proxy")}
            </button>
          )}
        </div>
      </div>
    </>
  );
}
