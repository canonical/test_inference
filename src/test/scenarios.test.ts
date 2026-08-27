import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deleteScenario, getScenario, putScenario, resolveOutcome, validateScenario } from "../scenarios.js";
import type { ChatMessage, InferenceOutcome, InferenceScenario } from "../types.js";
import { nextScope } from "./helpers.js";

const textOutcome: InferenceOutcome = { text: `ok` };
const context = (messages: ChatMessage[], scope = `scope`) => ({ scope, messages });
const rejects = (scenario: unknown, ...fragments: string[]): void => {
  const message = validateScenario(scenario);
  assert.ok(message, `expected rejection for ${JSON.stringify(scenario)}`);
  for (const fragment of fragments) assert.ok(message.includes(fragment), `expected "${message}" to mention "${fragment}"`);
};
const accepts = (scenario: unknown): void => assert.equal(validateScenario(scenario), null);

describe(`scenario shape`, () => {
  it(`accepts exact prompts mapped to response chains`, () => {
    accepts({ hello: [{ text: `hi` }], search: [{ toolCall: { name: `search` } }, { text: `done` }] });
  });

  it(`rejects non-objects and empty response chains`, () => {
    for (const value of [null, [], `text`, 3]) rejects(value, `must be an object`);
    rejects({ hello: [] }, `hello`, `non-empty array`);
    rejects({ hello: { text: `hi` } }, `hello`, `non-empty array`);
  });

  it(`accepts any ordered sequence of mocked responses`, () => {
    accepts({ hello: [{ text: `first` }, { text: `second` }] });
    accepts({ hello: [{ toolCall: { name: `lookup` } }, { text: `done` }] });
  });

  it(`validates every outcome`, () => {
    rejects({ hello: [{}] }, `exactly one`);
    rejects({ hello: [{ text: 42 }] }, `text`, `string`);
    rejects({ hello: [{ toolCall: {} }] }, `toolCall.name`);
    rejects({ hello: [{ toolCall: { name: `search`, arguments: [] } }] }, `arguments`, `object`);
    rejects({ hello: [{ error: { status: 500 } }] }, `status`);
  });
});

describe(`scenario resolution`, () => {
  it(`matches a complete user prompt exactly`, () => {
    const scenario: InferenceScenario = { "Plan the work": [{ text: `matched` }] };
    assert.deepEqual(resolveOutcome(scenario, context([{ role: `user`, content: `Plan the work` }]))?.outcome, { text: `matched` });
    assert.equal(resolveOutcome(scenario, context([{ role: `user`, content: `plan the work` }])), null);
    assert.equal(resolveOutcome(scenario, context([{ role: `user`, content: `Plan the work ` }])), null);
    assert.equal(resolveOutcome(scenario, context([{ role: `user`, content: `Please Plan the work` }])), null);
  });

  it(`uses the newest user message that exactly names a configured script`, () => {
    const scenario: InferenceScenario = { first: [{ text: `one` }], second: [{ text: `two` }] };
    const result = resolveOutcome(scenario, context([
      { role: `user`, content: `first` },
      { role: `assistant`, content: `intermediate` },
      { role: `user`, content: `second` },
      { role: `user`, content: `synthetic follow-up` },
    ]));
    assert.deepEqual(result?.outcome, { text: `two` });
  });

  it(`returns the same response for unchanged history`, () => {
    const scenario: InferenceScenario = { search: [{ toolCall: { name: `lookup`, arguments: { q: `x` } } }, { text: `done` }] };
    const messages: ChatMessage[] = [{ role: `user`, content: `search` }];
    assert.deepEqual(resolveOutcome(scenario, context(messages)), resolveOutcome(scenario, context(messages)));
  });

  it(`advances once for each assistant response after the prompt`, () => {
    const scenario: InferenceScenario = { run: [{ text: `first` }, { toolCall: { name: `second` } }, { text: `finished` }] };
    assert.deepEqual(resolveOutcome(scenario, context([{ role: `user`, content: `run` }]))?.outcome, { text: `first` });
    assert.deepEqual(resolveOutcome(scenario, context([
      { role: `user`, content: `run` },
      { role: `assistant`, content: `first` },
    ]))?.outcome, { toolCall: { name: `second` } });
    assert.deepEqual(resolveOutcome(scenario, context([
      { role: `user`, content: `run` },
      { role: `assistant`, content: `first` },
      { role: `tool`, content: `opaque result` },
      { role: `assistant`, content: null },
    ]))?.outcome, { text: `finished` });
  });

  it(`ignores non-assistant messages and stops after the configured sequence`, () => {
    const scenario: InferenceScenario = { run: [{ text: `only` }] };
    assert.deepEqual(resolveOutcome(scenario, context([
      { role: `user`, content: `run` },
      { role: `tool`, content: `opaque result` },
      { role: `user`, content: `synthetic follow-up` },
    ]))?.outcome, { text: `only` });
    assert.equal(resolveOutcome(scenario, context([
      { role: `user`, content: `run` },
      { role: `assistant`, content: `only` },
    ])), null);
  });
});

describe(`storage`, () => {
  it(`stores, replaces, deletes, and expires scenarios`, () => {
    const scope = nextScope(`storage`);
    const first: InferenceScenario = { first: [textOutcome] };
    const second: InferenceScenario = { second: [{ text: `second` }] };
    putScenario(scope, first);
    assert.deepEqual(getScenario(scope), first);
    putScenario(scope, second);
    assert.deepEqual(getScenario(scope), second);
    assert.equal(deleteScenario(scope), true);
    assert.equal(deleteScenario(scope), false);

    const originalNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    try {
      putScenario(scope, first);
      now += 10 * 60 * 1000;
      assert.equal(getScenario(scope), null);
    } finally {
      Date.now = originalNow;
    }
  });
});
