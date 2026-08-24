import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { postEmbeddings, startService } from "./helpers.js";

const service = startService();
const dataOf = (body: Record<string, unknown>): Array<{ index: number; embedding: number[] }> => body.data as Array<{ index: number; embedding: number[] }>;
const dot = (left: number[], right: number[]): number => left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);

describe(`embeddings`, () => {
  it(`is deterministic, sized by model, and returns entries out of order`, async () => {
    const first = await postEmbeddings(service.base, { model: `deterministic-embed-16`, input: [`first`, `second`] });
    const second = await postEmbeddings(service.base, { model: `deterministic-embed-16`, input: [`first`, `second`] });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.data, second.body.data);
    const data = first.body.data as Array<{ index: number; embedding: number[] }>;
    assert.deepEqual(data.map((entry) => entry.index), [1, 0]);
    assert.equal(data[0]?.embedding.length, 16);
  });

  it(`rejects unsupported models and non-text inputs`, async () => {
    assert.equal((await postEmbeddings(service.base, { model: `text-embedding-3-small`, input: `x` })).status, 400);
    assert.equal((await postEmbeddings(service.base, { model: `deterministic-embed-16`, input: [42] })).status, 400);
  });

  it(`gives identical text an identical vector`, async () => {
    const result = await postEmbeddings(service.base, { model: `deterministic-embed-16`, input: [`same`, `same`] });
    const byIndex = dataOf(result.body).sort((left, right) => left.index - right.index);
    assert.deepEqual(byIndex[0]?.embedding, byIndex[1]?.embedding);
  });

  it(`scores overlapping text closer than disjoint text`, async () => {
    const result = await postEmbeddings(service.base, { model: `deterministic-embed-1536`, input: [`login redirect`, `login redirects`, `banana tractor`] });
    const vectors = dataOf(result.body).sort((left, right) => left.index - right.index).map((entry) => entry.embedding);
    assert.ok(dot(vectors[0] ?? [], vectors[1] ?? []) > dot(vectors[0] ?? [], vectors[2] ?? []));
  });

  it(`distinguishes different scripts and punctuation`, async () => {
    const result = await postEmbeddings(service.base, { model: `deterministic-embed-64`, input: [`login`, `登录`, `!!!`, `🔥🔥`] });
    const vectors = dataOf(result.body).map((entry) => JSON.stringify(entry.embedding));
    assert.equal(new Set(vectors).size, 4);
  });

  it(`distinguishes anagrams`, async () => {
    const result = await postEmbeddings(service.base, { model: `deterministic-embed-64`, input: [`stop`, `pots`] });
    const vectors = dataOf(result.body);
    assert.notDeepEqual(vectors[0]?.embedding, vectors[1]?.embedding);
  });

  it(`returns unit vectors, including for empty text`, async () => {
    const result = await postEmbeddings(service.base, { model: `deterministic-embed-32`, input: [``, `hello`] });
    for (const { embedding } of dataOf(result.body)) assert.ok(Math.abs(Math.sqrt(dot(embedding, embedding)) - 1) < 1e-12);
  });

  it(`supports valid unadvertised dimensions`, async () => {
    const result = await postEmbeddings(service.base, { model: `deterministic-embed-7`, input: `hello` });
    assert.equal(result.status, 200);
    assert.equal(dataOf(result.body)[0]?.embedding.length, 7);
  });

  it(`rejects dimensions outside the supported range`, async () => {
    assert.equal((await postEmbeddings(service.base, { model: `deterministic-embed-0`, input: `x` })).status, 400);
    assert.equal((await postEmbeddings(service.base, { model: `deterministic-embed-4097`, input: `x` })).status, 400);
  });

  it(`rejects empty arrays and mixed input arrays`, async () => {
    assert.equal((await postEmbeddings(service.base, { model: `deterministic-embed-8`, input: [] })).status, 400);
    assert.equal((await postEmbeddings(service.base, { model: `deterministic-embed-8`, input: [`ok`, 1] })).status, 400);
  });

  it(`echoes the model and reports prompt usage`, async () => {
    const result = await postEmbeddings(service.base, { model: `deterministic-embed-8`, input: [`1234`, `12345678`] });
    assert.equal(result.body.model, `deterministic-embed-8`);
    assert.deepEqual(result.body.usage, { prompt_tokens: 3, total_tokens: 3 });
  });
});
