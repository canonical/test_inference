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
  "Fix login": [
    callsTool("define_title", { title: "Fix login" }),
    replies("Done."),
  ],
  "Summarize changes": [replies("Updated login handling.")],
});
```

Configure the application to use `apiKey`, then exercise it normally. Registration replaces any
existing scenario for that key. Scenarios expire after ten minutes and can be removed explicitly:

```ts
await inference.remove(apiKey);
```

### Prompt matching

Each scenario key is a complete user message. Matching is exact, case-sensitive, and untrimmed;
dictionary order has no effect. If no user message in the request history exactly matches a
registered key, the request returns `501`.

Each value is a non-empty sequence of assistant responses. A single response handles an ordinary
completion. For a sequence, each assistant message added to later request history advances to the
next configured response. Progress is therefore stateless and generic: retrying unchanged history
returns the same response regardless of its OpenAI assistant-message shape.

### Outcomes

| Builder | Result |
| --- | --- |
| `replies(text)` | Returns assistant text |
| `callsTool(name, arguments)` | Returns an assistant tool call |
| `fails(message?)` | Returns `502 Bad Gateway` |

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
- `deterministic-embed-1536`

For focused fixtures, an explicit `deterministic-embed-<dimensions>` model from 1 through 4096 is
also accepted, but custom widths are not advertised by the model list. Embeddings are stable for
identical input; response entries may be out of order and should be associated using their
`index` field.

## Development

Requires Node.js 20 or newer.

```sh
npm ci
npm run check
npm test
npm run test:package
```
