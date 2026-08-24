import type { ServerResponse } from "node:http";
import { respond, respondError } from "./http.js";
import { embeddingModelPattern } from "./models.js";
import { isPlainObject } from "./types.js";
import { estimateTokens, hashRange } from "./util.js";

/** Characters per window. Three distinguishes anagrams; more would only narrow overlap. */
const windowSize = 3;

const embedText = (text: string, dimensions: number): number[] => {
  const vector = new Array<number>(dimensions).fill(0);

  for (let start = 0; start < text.length; start += 1) {
    const hash = hashRange(text, start, Math.min(start + windowSize, text.length));
    const index = hash % dimensions;
    vector[index] = (vector[index] ?? 0) + (hash >>> 31 === 1 ? -1 : 1);
  }

  const norm = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));

  if (norm === 0) {
    vector[0] = 1;
    return vector;
  }

  return vector.map((value) => value / norm);
};

export const handleEmbeddings = (body: unknown, response: ServerResponse): void => {
  if (!isPlainObject(body)) {
    return respondError(response, 400, `Request body must be an object.`);
  }

  const model = typeof body.model === `string` ? body.model : ``;
  const dimensionMatch = embeddingModelPattern.exec(model);

  if (!dimensionMatch) {
    return respondError(response, 400, `Unknown embedding model: ${model || `(none)`}.`);
  }

  const dimensions = Number.parseInt(dimensionMatch[1] ?? ``, 10);

  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 4096) {
    return respondError(response, 400, `Unsupported embedding dimension: ${dimensionMatch[1]}.`);
  }

  const rawInput = body.input;
  const inputs = Array.isArray(rawInput) ? rawInput : [rawInput];

  if (inputs.length === 0 || inputs.some((value): value is Exclude<typeof value, string> => typeof value !== `string`)) {
    return respondError(response, 400, `input must be a string or an array of strings.`);
  }

  const texts = inputs as string[];
  const entries = texts.map((text, index) => ({ object: `embedding`, index, embedding: embedText(text, dimensions) }));
  const shuffled = [...entries].reverse();
  const promptTokens = texts.reduce((total, text) => total + estimateTokens(text), 0);

  return respond(response, 200, {
    object: `list`,
    model,
    data: shuffled,
    usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
  });
};
