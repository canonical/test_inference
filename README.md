# Test inference service

A deterministic, OpenAI-compatible service for end-to-end tests. It provides chat completions,
embeddings, and a model list without calling a real model.

Chat responses must be registered by the test. Missing or unmatched scenarios return `501`, so
tests cannot accidentally pass against an invented response. The bearer token scopes scenarios,
which keeps parallel tests isolated.

See [openapi.yaml](./openapi.yaml) for the complete HTTP contract.

## Install and run

```sh
npm install --save-dev @canonical/test-inference
npx test-inference # listens on port 8080
```

Set `PORT` to use another port:

```sh
PORT=8099 npx test-inference
```

Point the application under test at:

- Base URL: `http://localhost:8080/v1`
- API key: any non-empty, test-unique value
- Chat model: `deterministic-chat`

In a container stack, use the service's network address instead of `localhost`.

## Register a scenario

Register expected behavior before driving the application:

```ts
import { callsTool, createScenarioClient, replies } from "@canonical/test-inference";

const apiKey = crypto.randomUUID();
const inference = createScenarioClient("http://localhost:8080");

await inference.register(apiKey, {
  exchanges: [
    {
      when: { messagesContain: "Fix login" },
      outcome: replies("Done."),
    },
    {
      when: { toolOffered: "define_title" },
      outcome: callsTool("define_title", { title: "Fix login" }),
    },
  ],
  default: replies("Nothing to do."),
});
```

Configure the application to use `apiKey`, then exercise it normally. Registration replaces any
existing scenario for that key. Scenarios expire after ten minutes and can be removed explicitly:

```ts
await inference.remove(apiKey);
```

### Matchers

All fields in `when` must match. An omitted `when` matches every request. Exchanges are checked in
order and the first match wins.

| Matcher | Matches when |
| --- | --- |
| `model` | The request uses the given model |
| `lastMessageRole` | The final message has the given role |
| `userMessageEquals` | The latest user message exactly equals the value |
| `messagesContain` | Any message contains the value, case-insensitively |
| `toolOffered` | The request offers the named tool |

For multi-turn tool loops, put the later, more specific exchange first because earlier messages
remain in the conversation history.

### Outcomes

| Builder | Result |
| --- | --- |
| `replies(text)` | Returns assistant text |
| `callsTool(name, arguments)` | Returns an assistant tool call |
| `fails(message?)` | Returns `502 Bad Gateway` |

`default` is optional. Without it, an unmatched request returns `501`.

## Endpoints

- `GET /health` — health check; no authentication required
- `GET /v1/models` — fixed model catalog
- `POST /v1/chat/completions` — response from the caller's registered scenario
- `POST /v1/embeddings` — deterministic embeddings for a string or array of strings
- `PUT /_mock/scenarios/:scope` — register or replace a scenario
- `DELETE /_mock/scenarios/:scope` — remove a scenario

The `/v1` endpoints require `Authorization: Bearer <token>`; that token is the scenario scope.
Tokens beginning with `invalid-` are rejected with `401`. The health and scenario-control routes
do not require authentication.

Available models:

- `deterministic-chat`
- `deterministic-embed-8`
- `deterministic-embed-16`
- `deterministic-embed-1536`

Any `deterministic-embed-<dimensions>` model up to 4096 dimensions is also accepted. Embeddings
are stable for identical input; response entries may be out of order and should be associated
using their `index` field.

## Development

Requires Node.js 20 or newer.

```sh
npm ci
npm run check
npm test
npm run test:package
```
