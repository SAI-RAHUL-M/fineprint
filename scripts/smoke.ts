// Smoke test: every model answers, the JSON harness works, and (if KB_ID is set)
// we capture the raw Knowledge Base retrieval response to learn its citation format.
// Run: npm run smoke
import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { ALL_MODELS, BASE_URL, M } from "../src/lib/models";
import { callJSON, chat } from "../src/lib/llm";

config({ path: ".env.local" });
config();

const OUT = "scripts/out";
mkdirSync(OUT, { recursive: true });

async function pingAll() {
  console.log(`\n== Pinging ${ALL_MODELS.length} models ==`);
  const rows = await Promise.all(
    ALL_MODELS.map(async (model) => {
      try {
        // Pair the model with itself so a failure isn't hidden by a fallback.
        const { text, meta } = await chat([model, model], [{ role: "user", content: "Reply with exactly: pong" }], {
          maxTokens: 400,
        });
        return { model, ok: true, ms: meta.ms, reply: text.trim().slice(0, 30), tokens: meta.inputTokens + meta.outputTokens };
      } catch (e) {
        return { model, ok: false, ms: 0, reply: (e as Error).message.slice(0, 80), tokens: 0 };
      }
    }),
  );
  console.table(rows);
  return rows;
}

async function jsonHarness() {
  console.log("\n== JSON harness (fast model) ==");
  const schema = z.object({
    label: z.enum(["standard", "uncommon", "ask_about_this"]),
    explanation: z.string(),
    question_to_ask: z.string(),
  });
  const { data, meta } = await callJSON(
    M.fast,
    [
      {
        role: "user",
        content:
          'Clause: "Tenant shall pay a non-refundable cleaning fee of $600 at move-in." Return {label, explanation, question_to_ask}. label is one of standard|uncommon|ask_about_this.',
      },
    ],
    schema,
  );
  console.log(data, meta);
}

async function knowledgeBase() {
  const kb = process.env.KB_ID;
  if (!kb) {
    console.log("\n== KB retrieval skipped (set KB_ID in .env.local once the knowledge base is indexed) ==");
    return;
  }
  console.log("\n== KB retrieval via /v1/responses ==");
  const res = await fetch(`${BASE_URL}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.MODEL_ACCESS_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: M.fast[0],
      input: "What should a student ask a landlord about the security deposit? Cite your sources.",
      tools: [{ type: "knowledge_base_retrieval", knowledge_base_id: kb }],
      stream: false,
      max_output_tokens: 1024,
    }),
  });
  const body = await res.text();
  writeFileSync(`${OUT}/kb-response.json`, body);
  console.log(`status ${res.status}; full body saved to ${OUT}/kb-response.json`);
  console.log(body.slice(0, 1500));
}

async function main() {
  if (!process.env.MODEL_ACCESS_KEY) {
    console.error("MODEL_ACCESS_KEY missing: copy .env.example to .env.local and fill it in.");
    process.exit(1);
  }
  const rows = await pingAll();
  await jsonHarness().catch((e) => console.error("JSON harness failed:", e.message));
  await knowledgeBase().catch((e) => console.error("KB test failed:", e.message));
  const failed = rows.filter((r) => !r.ok).map((r) => r.model);
  console.log(failed.length ? `\n⚠ Swap these in src/lib/models.ts: ${failed.join(", ")}` : "\n✓ All models OK");
}

main();
