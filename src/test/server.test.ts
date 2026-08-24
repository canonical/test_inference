import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createScenarioClient } from "../client.js";
import { putScenario } from "../scenarios.js";
import { chatRequest, nextScope, postChat, registerScenario, startService } from "./helpers.js";

const service = startService();

describe(`server`, () => {
  it(`keeps health unauthenticated and rejects invalid credentials`, async () => {
    assert.equal((await fetch(`${service.base}/health`)).status, 200);
    assert.equal((await fetch(`${service.base}/v1/models`)).status, 401);
    assert.equal((await fetch(`${service.base}/v1/models`, { headers: { authorization: `Bearer invalid-key` } })).status, 401);
  });

  it(`exposes the scenario client with caller-selected scopes`, async () => {
    const client = createScenarioClient(service.base);
    const scope = nextScope(`client`);
    await client.register(scope, { default: { text: `client` } });
    assert.equal((await postChat(service.base, scope, chatRequest())).status, 200);
    await client.remove(scope);
    assert.equal((await postChat(service.base, scope, chatRequest())).status, 501);
  });

  it(`accepts any non-empty bearer as a scenario scope`, async () => {
    assert.equal((await fetch(`${service.base}/v1/models`, { headers: { authorization: `Bearer any-key` } })).status, 200);
  });

  it(`rejects malformed bearer credentials`, async () => {
    for (const authorization of [`Bearer   `, `any-key`, ``]) {
      assert.equal((await fetch(`${service.base}/v1/models`, { headers: { authorization } })).status, 401);
    }
  });

  it(`lists the chat and embedding model families`, async () => {
    const response = await fetch(`${service.base}/v1/models`, { headers: { authorization: `Bearer catalog` } });
    const body = await response.json() as { data: Array<{ id: string }> };
    assert.ok(body.data.some(({ id }) => id === `deterministic-chat`));
    assert.ok(body.data.some(({ id }) => id === `deterministic-embed-1536`));
  });

  it(`serves the documented inference routes`, async () => {
    assert.equal((await fetch(`${service.base}/v1/models`, { headers: { authorization: `Bearer routes` } })).status, 200);
    assert.notEqual((await fetch(`${service.base}/v1/embeddings`, { method: `POST`, headers: { authorization: `Bearer routes`, "content-type": `application/json` }, body: JSON.stringify({ model: `deterministic-embed-8`, input: `x` }) })).status, 404);
    assert.notEqual((await postChat(service.base, `routes`, chatRequest())).status, 404);
  });

  it(`rejects unsupported methods`, async () => {
    assert.equal((await fetch(`${service.base}/_mock/scenarios/scope`, { method: `POST` })).status, 405);
  });

  it(`rejects malformed percent encoding in scenario scopes`, async () => {
    assert.equal((await fetch(`${service.base}/_mock/scenarios/%zz`, { method: `DELETE` })).status, 400);
  });

  it(`rejects malformed scenario bodies`, async () => {
    const malformed = await fetch(`${service.base}/_mock/scenarios/malformed`, { method: `PUT`, headers: { "content-type": `application/json` }, body: `{oops` });
    assert.equal(malformed.status, 400);
  });

  it(`rejects invalid scenarios at the control boundary`, async () => {
    const result = await registerScenario(service.base, `invalid-scenario`, { default: { text: null } });
    assert.equal(result.status, 400);
    assert.match(String((result.body.error as { message: string }).message), /string/);
  });

  it(`replaces an existing caller-selected scope`, async () => {
    const scope = nextScope(`replace-http`);
    await registerScenario(service.base, scope, { default: { text: `first` } });
    await registerScenario(service.base, scope, { default: { text: `second` } });
    const result = await postChat(service.base, scope, chatRequest());
    assert.equal((result.body.choices as Array<{ message: { content: string } }>)[0]?.message.content, `second`);
  });

  it(`does not require credentials on the scenario control API`, async () => {
    assert.equal((await registerScenario(service.base, nextScope(`control`), { default: { text: `ok` } })).status, 200);
  });

  it(`contains an unexpected serialization failure and keeps listening`, async () => {
    const scope = nextScope(`fatal`);
    putScenario(scope, { default: { text: 1n as unknown as string } });
    assert.equal((await postChat(service.base, scope, chatRequest())).status, 500);
    assert.equal((await fetch(`${service.base}/health`)).status, 200);
  });
});
