import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chatRequest, nextScope, postChat, registerScenario, startService } from "./helpers.js";

const service = startService();
const scenario = (outcome: unknown) => ({ exchanges: [{ when: { model: `deterministic-chat` }, outcome }] });

describe(`chat completions`, () => {
  it(`requires a configured caller-supplied scope`, async () => {
    const scope = nextScope(`unconfigured`);
    const result = await postChat(service.base, scope, chatRequest());
    assert.equal(result.status, 501);
    assert.match(String((result.body.error as { message?: unknown }).message), new RegExp(scope));
  });

  it(`returns text and wraps bootstrap JSON content`, async () => {
    const scope = nextScope(`text`);
    assert.equal((await registerScenario(service.base, scope, scenario({ text: `ok` }))).status, 200);
    const result = await postChat(service.base, scope, chatRequest({ messages: [{ role: `user`, content: `Return a JSON object with key content` }] }));
    assert.equal(result.status, 200);
    const choice = (result.body.choices as Array<{ message: { content: string } }>)[0];
    assert.equal(choice?.message.content, JSON.stringify({ content: `ok` }));
  });

  it(`returns tool calls and configured provider failures`, async () => {
    const toolScope = nextScope(`tool`);
    await registerScenario(service.base, toolScope, scenario({ toolCall: { name: `search`, arguments: { q: `query` } } }));
    const toolResult = await postChat(service.base, toolScope, chatRequest());
    assert.equal((toolResult.body.choices as Array<{ finish_reason: string }>)[0]?.finish_reason, `tool_calls`);

    const errorScope = nextScope(`error`);
    await registerScenario(service.base, errorScope, scenario({ error: { message: `upstream failed` } }));
    const errorResult = await postChat(service.base, errorScope, chatRequest());
    assert.equal(errorResult.status, 502);
  });

  it(`describes an unmatched configured request`, async () => {
    const scope = nextScope(`unmatched`);
    await registerScenario(service.base, scope, { exchanges: [{ when: { toolOffered: `search` }, outcome: { text: `unused` } }] });
    const result = await postChat(service.base, scope, chatRequest());
    assert.equal(result.status, 501);
    assert.match(String((result.body.error as { message: string }).message), /lastMessageRole=user/);
    assert.match(String((result.body.error as { message: string }).message), /messages=1/);
  });

  it(`rejects a model outside the advertised chat catalog`, async () => {
    const scope = nextScope(`model`);
    await registerScenario(service.base, scope, { default: { text: `unused` } });
    const result = await postChat(service.base, scope, chatRequest({ model: `gpt-4o` }));
    assert.equal(result.status, 400);
    assert.match(String((result.body.error as { message: string }).message), /gpt-4o/);
  });

  it(`returns configured text verbatim unless Athena requests JSON content`, async () => {
    const scope = nextScope(`verbatim`);
    await registerScenario(service.base, scope, { default: { text: `  spaced  ` } });
    const plain = await postChat(service.base, scope, chatRequest());
    const wrapped = await postChat(service.base, scope, chatRequest({ messages: [{ role: `user`, content: `Return a JSON object with key content` }] }));
    assert.equal((plain.body.choices as Array<{ message: { content: string } }>)[0]?.message.content, `  spaced  `);
    assert.equal((wrapped.body.choices as Array<{ message: { content: string } }>)[0]?.message.content, JSON.stringify({ content: `  spaced  ` }));
  });

  it(`defaults omitted tool arguments to an empty JSON object`, async () => {
    const scope = nextScope(`arguments`);
    await registerScenario(service.base, scope, { default: { toolCall: { name: `search` } } });
    const result = await postChat(service.base, scope, chatRequest());
    const calls = (result.body.choices as Array<{ message: { tool_calls: Array<{ function: { arguments: string } }> } }>)[0]?.message.tool_calls;
    assert.deepEqual(JSON.parse(calls?.[0]?.function.arguments ?? `null`), {});
  });

  it(`is a pure function of the request and scenario`, async () => {
    const scope = nextScope(`pure`);
    await registerScenario(service.base, scope, { default: { text: `same` } });
    assert.deepEqual(await postChat(service.base, scope, chatRequest()), await postChat(service.base, scope, chatRequest()));
  });

  it(`reports deterministic usage estimated from the prompt`, async () => {
    const scope = nextScope(`usage`);
    await registerScenario(service.base, scope, { default: { text: `hi` } });
    const result = await postChat(service.base, scope, chatRequest({ messages: [{ role: `user`, content: `12345678` }] }));
    const usage = result.body.usage as { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    assert.equal(usage.prompt_tokens, 2);
    assert.equal(usage.total_tokens, usage.prompt_tokens + usage.completion_tokens);
  });

  it(`accepts a tool result after an assistant tool call with null content`, async () => {
    const scope = nextScope(`history`);
    await registerScenario(service.base, scope, { exchanges: [{ when: { lastMessageRole: `tool` }, outcome: { text: `read it` } }] });
    const result = await postChat(service.base, scope, chatRequest({ messages: [
      { role: `user`, content: `Plan` },
      { role: `assistant`, content: null, tool_calls: [{ id: `call`, type: `function`, function: { name: `search`, arguments: `{}` } }] },
      { role: `tool`, content: `result` },
    ] }));
    assert.equal(result.status, 200);
    assert.equal((result.body.choices as Array<{ message: { content: string } }>)[0]?.message.content, `read it`);
  });

  it(`ignores sampling fields that cannot alter a declared answer`, async () => {
    const scope = nextScope(`sampling`);
    await registerScenario(service.base, scope, { default: { text: `unchanged` } });
    const result = await postChat(service.base, scope, chatRequest({ temperature: 0.9, top_p: 0.1, seed: 7, stream: false, n: 1 }));
    assert.equal(result.status, 200);
    assert.equal((result.body.choices as Array<{ message: { content: string } }>)[0]?.message.content, `unchanged`);
  });

  it(`uses the first matching exchange before a default`, async () => {
    const scope = nextScope(`precedence`);
    await registerScenario(service.base, scope, {
      exchanges: [{ when: { model: `deterministic-chat` }, outcome: { text: `exchange` } }],
      default: { text: `default` },
    });
    const result = await postChat(service.base, scope, chatRequest());
    assert.equal((result.body.choices as Array<{ message: { content: string } }>)[0]?.message.content, `exchange`);
  });
});
