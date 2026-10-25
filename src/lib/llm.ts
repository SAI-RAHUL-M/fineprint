import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { z } from "zod";
import { BASE_URL, type ModelPair } from "./models";

let client: OpenAI | null = null;

// Lazy so `next build` doesn't need the key.
export function ai(): OpenAI {
  if (!client) {
    const apiKey = process.env.MODEL_ACCESS_KEY;
    if (!apiKey) throw new Error("MODEL_ACCESS_KEY is not set");
    client = new OpenAI({ baseURL: BASE_URL, apiKey, maxRetries: 1, timeout: 90_000 });
  }
  return client;
}

export type Msg = ChatCompletionMessageParam;

export interface CallMeta {
  model: string;
  ms: number;
  inputTokens: number;
  outputTokens: number;
  usedFallback: boolean;
  repaired: boolean;
}

export interface ChatOpts {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export async function chat(models: ModelPair, messages: Msg[], opts: ChatOpts = {}) {
  let lastErr: unknown;
  for (const [i, model] of models.entries()) {
    const t0 = Date.now();
    try {
      const res = await ai().chat.completions.create(
        {
          model,
          messages,
          temperature: opts.temperature ?? 0.2,
          max_completion_tokens: opts.maxTokens ?? 4000,
        },
        { signal: opts.signal },
      );
      const text = res.choices[0]?.message?.content ?? "";
      if (!text.trim()) throw new Error(`empty response from ${model}`);
      const meta: CallMeta = {
        model: res.model || model,
        ms: Date.now() - t0,
        inputTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
        usedFallback: i > 0,
        repaired: false,
      };
      return { text, meta };
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      lastErr = err;
      console.warn(`[llm] ${model} failed: ${(err as Error).message}`);
    }
  }
  throw lastErr;
}

const JSON_RULES =
  "Respond with ONLY one JSON object that matches the requested schema. No prose, no markdown, no code fences.";

// Pulls the first balanced {...} out of a model reply (handles fences and <think> blocks).
export function extractJSON(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  if (start === -1) throw new Error("no JSON object found");
  let depth = 0;
  let inStr = false;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return JSON.parse(cleaned.slice(start, i + 1));
  }
  throw new Error("unterminated JSON object");
}

// Chat call whose reply must parse and validate against `schema`; one repair retry on failure.
export async function callJSON<T>(
  models: ModelPair,
  messages: Msg[],
  schema: z.ZodType<T>,
  opts: ChatOpts = {},
): Promise<{ data: T; meta: CallMeta }> {
  const withRules: Msg[] = [{ role: "system", content: JSON_RULES }, ...messages];
  const first = await chat(models, withRules, opts);

  const problem = validate(first.text, schema);
  if (problem.ok) return { data: problem.data, meta: first.meta };

  // Repair on the model that actually answered, so the conversation stays coherent.
  const answered: ModelPair = [first.meta.model, first.meta.model];
  const second = await chat(
    answered,
    [
      ...withRules,
      { role: "assistant", content: first.text },
      { role: "user", content: `That reply was invalid: ${problem.error}. Return ONLY the corrected JSON object.` },
    ],
    opts,
  );
  const fixed = validate(second.text, schema);
  if (!fixed.ok) throw new Error(`invalid JSON from ${second.meta.model} after repair: ${fixed.error}`);
  return {
    data: fixed.data,
    meta: {
      ...second.meta,
      ms: first.meta.ms + second.meta.ms,
      inputTokens: first.meta.inputTokens + second.meta.inputTokens,
      outputTokens: first.meta.outputTokens + second.meta.outputTokens,
      usedFallback: first.meta.usedFallback,
      repaired: true,
    },
  };
}

function validate<T>(text: string, schema: z.ZodType<T>): { ok: true; data: T } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = extractJSON(text);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, error: z.prettifyError(parsed.error).slice(0, 800) };
}
