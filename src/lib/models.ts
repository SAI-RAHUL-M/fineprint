// All open-weight models on DigitalOcean Serverless Inference.
// Each role is [primary, fallback]; llm.ts retries on the fallback if the primary errors.
export const BASE_URL = "https://inference.do-ai.run/v1";

export const M = {
  jurorA: ["openai-gpt-oss-120b", "deepseek-3.2"],
  jurorB: ["qwen3.5-397b-a17b", "gemma-4-31B-it"],
  fast: ["openai-gpt-oss-20b", "mistral-3-14B"],
  writer: ["openai-gpt-oss-120b", "glm-5.2"],
} as const satisfies Record<string, readonly [string, string]>;

export type Role = keyof typeof M;
export type ModelPair = readonly [string, string];

export const ALL_MODELS = [...new Set(Object.values(M).flat())];
