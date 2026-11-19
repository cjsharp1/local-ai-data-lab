/**
 * try-model.ts — one raw request to the local model, printed in full.
 *
 * Run it with:  npm run try-model
 *               npm run try-model -- "Your own question here"
 *
 * Sends a single chat request to Ollama — no tools, no data, no agent
 * loop — and prints the exact JSON that went out and the exact JSON that
 * came back, followed by the figures worth reading in it.
 *
 * This is the smallest possible look at what every other part of the app
 * is built on. Things to notice in the output:
 *
 *   - There is no API key anywhere in the request. Nothing authenticates,
 *     because nothing leaves the machine.
 *   - `think: false`. Remove it (edit buildRequest in server/model/
 *     ollama.ts) and watch the same answer take many times longer.
 *   - `load_duration`. The first request after the model has been idle
 *     includes loading it into memory — often several seconds. Run the
 *     script twice in a row and compare.
 *   - `prompt_eval_count` and `eval_count`: tokens in and tokens out. There
 *     is no bill, so the useful figure is speed: eval_count over
 *     eval_duration, in tokens per second.
 *   - Ask it about Checkpoint Outfitters and it will make something up, or
 *     say it does not know. The model has never seen the data. Only the
 *     tools can show it — which is the point of the rest of the app.
 */

import "dotenv/config";
import {
  OllamaUnreachableError, ModelNotFoundError, buildRequest, chat, ms, ollamaConfig, tokensPerSecond,
} from "../server/model/ollama.js";

const question = process.argv.slice(2).join(" ") ||
  "In one sentence: what is Checkpoint Outfitters, and who is their customer Dana Whitlock?";

const { model, url } = ollamaConfig();
const request = buildRequest({
  model,
  messages: [
    { role: "system", content: "You are a helpful assistant. Be brief." },
    { role: "user", content: question },
  ],
});

console.log(`POST ${url}/api/chat\n`);
console.log("--- request ---");
console.log(JSON.stringify(request, null, 2));

try {
  const response = await chat(request);
  console.log("\n--- response ---");
  console.log(JSON.stringify(response, null, 2));

  console.log("\n--- reading it ---");
  console.log(`reply           ${response.message.content}`);
  console.log(`model load      ${ms(response.load_duration)} ms${ms(response.load_duration) > 1000 ? "  (cold start — run again to compare)" : ""}`);
  console.log(`tokens in       ${response.prompt_eval_count ?? "?"}  (context window: ${request.options.num_ctx})`);
  console.log(`tokens out      ${response.eval_count ?? "?"}`);
  console.log(`speed           ${tokensPerSecond(response) ?? "?"} tokens/second`);
  console.log(`total           ${ms(response.total_duration)} ms`);
  console.log("cost            $0 — this ran on your machine");
} catch (error: unknown) {
  if (error instanceof OllamaUnreachableError || error instanceof ModelNotFoundError) {
    console.error(`\n${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
