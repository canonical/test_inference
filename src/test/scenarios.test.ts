import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deleteScenario, getScenario, putScenario, resolveOutcome, validateScenario } from "../scenarios.js";
import type { ChatMessage, InferenceMatcher, InferenceOutcome, InferenceScenario } from "../types.js";
import { nextScope } from "./helpers.js";

const textOutcome: InferenceOutcome = { text: `ok` };
const exchange = (when?: InferenceMatcher, outcome: InferenceOutcome = textOutcome): InferenceScenario => ({ exchanges: [when === undefined ? { outcome } : { when, outcome }] });
const configured = (outcome: InferenceOutcome): InferenceScenario => exchange({ model: `deterministic-chat` }, outcome);
const rejects = (scenario: unknown, ...fragments: string[]): void => {
  const message = validateScenario(scenario);
  assert.ok(message, `expected rejection for ${JSON.stringify(scenario)}`);
  for (const fragment of fragments) assert.ok(message.includes(fragment), `expected "${message}" to mention "${fragment}"`);
};
const accepts = (scenario: unknown): void => assert.equal(validateScenario(scenario), null);
const context = (overrides: Partial<{ model: string; messages: ChatMessage[]; toolNames: Set<string> }> = {}) => ({
  model: `deterministic-chat`, messages: [{ role: `user`, content: `Plan the work` }], toolNames: new Set<string>(), ...overrides,
});

describe(`scenario shape`, () => {
  it(`accepts exchanges, an explicit default, or both`, () => {
    accepts({ exchanges: [] }); accepts({ default: textOutcome }); accepts({ exchanges: [], default: textOutcome });
  });
  it(`rejects a non-object`, () => { for (const value of [null, [], `text`, 3]) rejects(value, `must be an object`); });
  it(`rejects exchanges that are not an array of objects`, () => {
    rejects({ exchanges: {} }, `must be an array`);
    rejects({ exchanges: [null] }, `exchanges[0]`, `must be an object`);
    rejects({ exchanges: [[]] }, `exchanges[0]`, `must be an object`);
  });
  it(`accepts an omitted or empty matcher as an intentional catch-all`, () => {
    accepts({ exchanges: [{ outcome: textOutcome }] }); accepts(exchange({}));
  });
});

describe(`matcher validation and resolution`, () => {
  it(`accepts every documented matcher`, () => {
    for (const when of [{ model: `deterministic-chat` }, { lastMessageRole: `tool` as const }, { userMessageEquals: `.` }, { messagesContain: `plan` }, { toolOffered: `search` }]) accepts(exchange(when));
  });
  it(`rejects a non-object matcher`, () => {
    rejects({ exchanges: [{ when: `user`, outcome: textOutcome }] }, `when must be an object`);
    rejects({ exchanges: [{ when: [], outcome: textOutcome }] }, `when must be an object`);
  });
  it(`rejects an unknown matcher and names it`, () => rejects({ exchanges: [{ when: { userMessageContains: `hi` }, outcome: textOutcome }] }, `userMessageContains`));
  it(`takes the first matching exchange`, () => {
    const scenario: InferenceScenario = { exchanges: [
      { when: { messagesContain: `absent` }, outcome: { text: `wrong` } },
      { when: { messagesContain: `plan` }, outcome: { text: `right` } },
      { when: { messagesContain: `plan` }, outcome: { text: `never` } },
    ] };
    assert.deepEqual(resolveOutcome(scenario, context()), { outcome: { text: `right` }, source: `exchange[1]` });
  });
  it(`matches message substrings case-insensitively anywhere in history`, () => {
    const history = context({ messages: [{ role: `system`, content: `You are a planner.` }, { role: `user`, content: `Plan the work` }] });
    assert.ok(resolveOutcome(exchange({ messagesContain: `PLANNER` }), history));
    assert.ok(resolveOutcome(exchange({ messagesContain: `plan the WORK` }), history));
    assert.equal(resolveOutcome(exchange({ messagesContain: `missing` }), history), null);
  });
  it(`matches the most recent user message exactly`, () => {
    const history = context({ messages: [{ role: `user`, content: `first` }, { role: `user`, content: `.` }, { role: `tool`, content: `result` }] });
    assert.ok(resolveOutcome(exchange({ userMessageEquals: `.` }), history));
    assert.equal(resolveOutcome(exchange({ userMessageEquals: `. ` }), history), null);
  });
  it(`distinguishes an absent user message from an empty one`, () => {
    assert.equal(resolveOutcome(exchange({ userMessageEquals: `` }), context({ messages: [{ role: `system`, content: `x` }] })), null);
    assert.ok(resolveOutcome(exchange({ userMessageEquals: `` }), context({ messages: [{ role: `user`, content: `` }] })));
  });
  it(`matches the final role`, () => {
    const history = context({ messages: [{ role: `user`, content: `question` }, { role: `tool`, content: `result` }] });
    assert.ok(resolveOutcome(exchange({ lastMessageRole: `tool` }), history));
    assert.equal(resolveOutcome(exchange({ lastMessageRole: `assistant` }), history), null);
  });
  it(`handles null assistant content in tool-call history`, () => {
    const history = context({ messages: [{ role: `assistant`, content: null, tool_calls: [{}] }, { role: `tool`, content: `search result` }] });
    assert.ok(resolveOutcome(exchange({ messagesContain: `search result` }), history));
  });
  it(`requires every supplied matcher to pass`, () => {
    const when = { model: `deterministic-chat`, messagesContain: `Plan`, toolOffered: `search` };
    assert.equal(resolveOutcome(exchange(when), context()), null);
    assert.ok(resolveOutcome(exchange(when), context({ toolNames: new Set([`search`]) })));
  });
  it(`uses an explicit default only after exchanges miss`, () => {
    const scenario: InferenceScenario = { exchanges: [{ when: { model: `other` }, outcome: { text: `wrong` } }], default: { text: `fallback` } };
    assert.deepEqual(resolveOutcome(scenario, context()), { outcome: { text: `fallback` }, source: `default` });
  });
  it(`resolves to nothing without a match or default`, () => {
    assert.equal(resolveOutcome(exchange({ toolOffered: `search` }), context()), null); assert.equal(resolveOutcome({}, context()), null);
  });
});

describe(`outcome validation`, () => {
  it(`accepts text, tool calls, and provider errors`, () => {
    for (const outcome of [{ text: `` }, { toolCall: { name: `search` } }, { toolCall: { name: `search`, arguments: { q: `x` } } }, { error: {} }, { error: { message: `failed` } }]) accepts(configured(outcome as InferenceOutcome));
  });
  it(`rejects a missing or malformed outcome`, () => {
    rejects({ exchanges: [{ when: {} }] }, `outcome`, `must be an object`); rejects({ exchanges: [{ when: {}, outcome: [] }] }, `outcome`, `must be an object`);
  });
  it(`rejects unknown outcome keys`, () => rejects({ default: { text: `hi`, toolcall: {} } }, `toolcall`));
  it(`requires exactly one outcome variant`, () => { rejects({ default: {} }, `exactly one`); rejects({ default: { text: `hi`, error: {} } }, `exactly one`); });
  it(`requires text to be a string`, () => { rejects({ default: { text: null } }, `text`, `string`); rejects({ default: { text: 42 } }, `text`, `string`); });
  it(`requires a tool-call object and name`, () => { rejects({ default: { toolCall: null } }, `toolCall.name`); rejects({ default: { toolCall: {} } }, `toolCall.name`); });
  it(`rejects malformed provider errors`, () => {
    rejects({ default: { error: null } }, `error`, `object`); rejects({ default: { error: { status: 500 } } }, `status`); rejects({ default: { error: { message: 42 } } }, `message`, `string`);
  });
});

describe(`storage`, () => {
  it(`stores and retrieves a scenario by scope`, () => {
    const scope = nextScope(`store`); putScenario(scope, configured({ text: `stored` })); assert.deepEqual(getScenario(scope), configured({ text: `stored` }));
  });
  it(`replaces a scope outright`, () => {
    const scope = nextScope(`replace`); putScenario(scope, configured({ text: `first` })); putScenario(scope, { default: { text: `second` } }); assert.deepEqual(getScenario(scope), { default: { text: `second` } });
  });
  it(`deletes a scope idempotently`, () => {
    const scope = nextScope(`delete`); putScenario(scope, { default: textOutcome }); assert.equal(deleteScenario(scope), true); assert.equal(deleteScenario(scope), false); assert.equal(getScenario(scope), null);
  });
  it(`expires scenarios lazily after ten minutes`, () => {
    const scope = nextScope(`expiry`); const originalNow = Date.now; let now = 1_000; Date.now = () => now;
    try { putScenario(scope, { default: textOutcome }); now += 10 * 60 * 1000 - 1; assert.ok(getScenario(scope)); now += 1; assert.equal(getScenario(scope), null); } finally { Date.now = originalNow; }
  });
});
