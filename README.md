# Test inference service

A deterministic, OpenAI-compatible inference service for end-to-end test stacks.

It serves the three endpoints an application typically needs from a model provider —
`GET /v1/models`, `POST /v1/chat/completions`, `POST /v1/embeddings` — and answers **only what
you told it to**. Your application reaches it the way it reaches any provider: a base URL and an
API key, configured through whatever configuration surface it already has. Nothing in your
application code needs to know the service exists.

No runtime dependencies, one build step, one Node process. The implementation is strict
TypeScript compiled to `dist` for Node and package consumers.

The service returns only outcomes explicitly configured by a test. When no scenario is configured
or no exchange matches, it fails loudly instead of inventing a plausible response.

- [openapi.yaml](./openapi.yaml) — the formal wire contract: endpoints, schemas, status codes.
- This README — the reasoning and the semantics a schema cannot express.

They are meant to be read together.

---

## Why this rather than a mock inside the test

A request-interception mock lives inside your test or your application process, so it proves
nothing about the code path that actually talks to a provider — the client, the retry policy,
the credential handling, the response parsing. This runs as a **service in your stack**, so all
of that is exercised for real. Only the model's judgement is replaced.

That framing matters for test-strategy rules that ban doubles: this is not a double *inside* the
application, it is a dependency the application reaches through its ordinary configuration.

## Every answer is declared

Chat completions come from the scenario registered for the request's scope, and nowhere else.
There is no implicit fallback behavior. A request arriving on a scope with no scenario, or one
where no exchange matches and no explicit `default` was registered, is a **`501` naming the
scope** — never a plausible-looking completion.

That is the whole design. A model's answers are decisions, not pure functions of the request, so
a service that invents one is deciding something your test never stated. A test that forgot to
register, registered under a key its configuration does not carry, or wrote a matcher that never
fires would then pass against that invention. Failing at the cause costs one line per test and
buys back the entire class of bug.

The consequence to hold onto: **this is a test double, plainly.** Every test that drives a
completion is coupled to it. Swapping in a real model would not leave those tests standing.

`/v1/models` and `/v1/embeddings` need no scenario. Neither decides anything — the catalog is
fixed and a vector is a pure function of its input text — so there is nothing to declare, and
requiring it would be ceremony.

---

## Install

```
npm install --save-dev @canonical/test-inference
```

When working from source, install dependencies and compile it first:

```
npm install
npm run build
```

## Run

Standalone:

```
npx test-inference                 # PORT defaults to 8080
PORT=8099 npx test-inference
```

In Docker Compose, with no image to build — bind-mount the package into a stock Node image:

```yaml
test-inference:
  image: node:24-alpine
  command: ["node", "/srv/dist/server.js"]
  environment:
    PORT: "8080"
  # Loopback only: the scenario API should be reachable from your test process and nothing else.
  ports:
    - "127.0.0.1:${TEST_INFERENCE_HOST_PORT:-8099}:8080"
  volumes:
    - ./node_modules/@canonical/test-inference:/srv:ro
  healthcheck:
    test: ["CMD-SHELL", "node -e \"fetch('http://localhost:8080/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
    interval: 10s
    timeout: 5s
    retries: 10
    start_period: 5s
```

Have your application service `depends_on` it with `condition: service_healthy`.

Check it is up:

```
curl -s -H "Authorization: Bearer any-key" http://127.0.0.1:8099/v1/models
```

## Quick start

**1. Point your application at it.** Create whatever record your application uses for a model
provider, with the base URL of this service and *any non-empty* API key:

| Field | Value |
| --- | --- |
| Base URL | `http://test-inference:8080/v1` — the address **your application** uses |
| API key | Anything unique to this test — it is the scope key, see below |
| Model | `deterministic-chat` |

**2. Register what the model should do,** from your test:

```ts
import { callsTool, createScenarioClient, replies } from "@canonical/test-inference";

// The address *your test* uses, which is not always the one your application uses.
const inference = createScenarioClient(`http://localhost:8099`);

await inference.register(apiKey, {
  exchanges: [
    { when: { toolOffered: `define_title` },
      outcome: callsTool(`define_title`, { title: `Fix login` }) },
  ],
  default: replies(`Nothing to do.`),
});
```

**3. Drive your application** through its UI or API as you normally would.

**4. Assert on what your application did** with the answer — the record it wrote, the state it
changed — not on the wording you configured. A test asserting an effect survives any change to
the canned response; one asserting the wording is pinned to your fixture.

**5. Optionally clean up.** `await inference.remove(apiKey)`. Scenarios expire on their own
after ten minutes, so this is tidiness rather than a requirement.

---

## Scoping: how parallel tests stay isolated

The **bearer token is the scope key**. An API key is unconstrained free text in most
applications, and it travels on every request as `Authorization: Bearer …` — so a test registers
behavior under a key, configures that key as its provider credential, and every request that
test causes arrives already scoped.

One service instance therefore serves any number of tests running in parallel without them
seeing each other's configuration. Use a key unique per test — a uuid is the safe choice; clock
stamps collide across worker processes spawned together.

```
PUT    /_mock/scenarios/<scope>    register or replace
DELETE /_mock/scenarios/<scope>    remove
```

The control routes carry **no bearer** — your test calls them directly rather than through the
application.

**Two addresses, one listener.** Inside a container network the application reaches
`http://test-inference:8080/v1`; your test process usually runs on the host, where that name does not
resolve, so it uses the published loopback port. Configure each with the address it can reach.

---

## Scenario reference

### Shape

```json
{
  "exchanges": [
    { "when": { "messagesContain": "Fix login" },
      "outcome": { "text": "Title set." } },
    { "when": { "toolOffered": "define_title" },
      "outcome": { "toolCall": { "name": "define_title", "arguments": { "title": "Fix login" } } } }
  ],
  "default": { "text": "Nothing to do." }
}
```

That is a two-turn exchange, and the ordering is the trick. `Fix login` reaches the message
history only inside the tool's result, so the first exchange cannot match until the tool has
run — and once it can, being listed first is what stops the second from firing again. See
*Matching a multi-turn loop* for why it is written this way rather than the obvious way.

`default` answers everything the exchanges do not, and is how a test says "I don't care what
happens here" — model validation, a bootstrap prompt, a turn beside the one under test. Without
it, those requests are a `501`.

Registration **replaces** a scope's scenario outright; it does not merge.

### Matchers

All optional, all must pass, an absent `when` always matches.

| Matcher | Matches when |
| --- | --- |
| `model` | The request names this model |
| `lastMessageRole` | The final message has this role (`user`, `tool`, `assistant`) — see the caveat below |
| `userMessageEquals` | The most recent `user` message is **exactly** this string — case-sensitive, untrimmed |
| `messagesContain` | Any message in the conversation contains this substring, case-insensitively |
| `toolOffered` | The request's `tools` array offers this tool name |

`userMessageEquals` is exact on purpose, and there is deliberately no substring form of it. The
request it exists for is the probe an application sends to check that a model exists — commonly
a single character, `"."` or `"1"` — and any substring matcher short enough to name one is also
short enough to match every real message in the conversation. Only an exact comparison
distinguishes a probe from a turn, which is what lets the code that *configures* a provider
declare the answer its own validation needs, without a blanket `default` covering the whole
test.

### Outcomes

Exactly one per exchange.

| Outcome | Builder | Effect |
| --- | --- | --- |
| `text` | `replies(text)` | Assistant text, `finish_reason: stop` |
| `toolCall` | `callsTool(name, args)` | A tool call, `finish_reason: tool_calls` |
| `error` | `fails(message)` | Returned as HTTP `502 Bad Gateway` |

Configured failures always return `502`. The message is optional; a supplied `status` is rejected
as an unknown error key so `501` remains reserved for missing or unmatched scenarios.

Unknown matcher or outcome keys are **rejected at registration**, with a message naming the
known ones — so a typo fails loudly instead of silently never matching. So is a key whose value
is empty: `{ toolCall: null }` names a real outcome and specifies nothing, which would otherwise
resolve as empty assistant text.

### Matching a multi-turn loop

Agent loops commonly append their own trailing prompt message to every request — "return a JSON
object with key `content`", or similar. Where that happens, the two matchers you reach for first
are traps:

- `lastMessageRole` is `user` on **every** turn. It is never `tool`, even on the turn whose whole
  purpose is answering a tool result — the tool message is second to last.
- `userMessageEquals` only ever sees that trailing boilerplate, never what a person typed. The
  real instruction is in the history, but it is not the most recent user message.

Check whether your host does this before relying on either. When it does, use `messagesContain`,
which scans the whole conversation, and `toolOffered`, which reads the request rather than the
history — and keep `userMessageEquals` for the fixed probes it is meant for, which a task loop
does not send.

The second half of the problem: the history only grows, so an exchange matching turn one matches
turn three too, and first-match-wins hands it the continuation as well. Key the later turn on
something that enters the history **only once the earlier turn has happened** — a tool result
echoing an argument your test chose is the reliable one — and list it first.

### First match wins, and matching never counts calls

There is deliberately no call-ordinal matcher. Clients retry failed completions, so any
counter-based scheme would have retries silently consume slots and present as nondeterminism in
the model.

You do not need one. The conversation *is* the sequence — the message history grows every turn,
so content matching already distinguishes turn one from turn three.

### Response shaping

When any message in the request asks the model to *"Return a JSON object with key content"* — a
common bootstrap instruction — a `text` outcome is wrapped as `{"content": "..."}`, because a
compliant model would obey. Otherwise it is returned as plain text.

Scenarios specify what the assistant *says*, never the wire format.

---

## Contract

Depend on the behaviors in this section, and only on these. Needing something not listed here
means extending the service and this document in the same change.

### Nothing a request contains is fatal

The service answers a request it cannot handle with a `500` naming the failure, and keeps
listening. This is a contract, not an implementation detail, because the alternative is far
worse than one failed request: a process that exits takes every test with it, including the ones
already passing and the ones that never touched the cause. What you would see is a suite failing
on connection-refused everywhere, with the one test responsible indistinguishable from the rest.

So a `500` from this service means a defect in it — file it — and the test that provoked it is
the one that fails.

### Authentication

Every endpoint except `/health` requires `Authorization: Bearer <token>`.

| Token | Result |
| --- | --- |
| Missing or empty | `401` |
| Begins with `invalid-` | `401` |
| Anything else non-empty | Accepted |

The `invalid-` sentinel exists so the credential-failure path stays reachable from a form that
requires a non-empty key. There is no way to submit an empty one.

### `GET /v1/models`

Returns the OpenAI model-list shape (`{ object: "list", data: [...] }`). Applications typically
call this when a provider is created or edited, to populate a model picker — so a service
without it often cannot be configured at all.

| Model | `name` | Kind |
| --- | --- | --- |
| `deterministic-chat` | `Deterministic Chat` | Chat completions |
| `deterministic-embed-8` | `Deterministic Embeddings (8 dimensions)` | Embeddings, 8 dimensions |
| `deterministic-embed-16` | `Deterministic Embeddings (16 dimensions)` | Embeddings, 16 dimensions |
| `deterministic-embed-1536` | `Deterministic Embeddings (1536 dimensions)` | Embeddings, 1536 dimensions |

The `name` is part of the contract, not decoration: a picker that renders a model's display name
is showing this string, so a test asserting that a fetch replaced bare ids with human labels has
nothing else to name. It differs from the id in every case, deliberately, so such a test can
tell the two apart.

Any `deterministic-embed-<n>` up to 4096 works, advertised or not — the dimension is read from
the name. That is how a test exercises dimension handling without the service needing to know
which widths matter.

Model **names** are global; model **behavior** is not. A test that wants a model to fail or
answer differently declares that in its own scenario, keyed on `model`.

### `POST /v1/embeddings`

Accepts `{ input, model }`, where `input` is a string or an array of strings. Unknown models are
rejected with `400`.

Vectors come from a hashing vectorizer over **character windows**. One window of three
characters starts at every position in the text; each is hashed with FNV-1a into a bucket with a
signed count, and the result is L2 normalized. Meaningless as semantics, deliberately
discriminating:

- **Identical text yields an identical vector.** A query using a chunk's exact text ranks that
  chunk first, which is what catches text paired to the wrong vector.
- **Overlapping text scores closer than disjoint text.** Enough to assert ordering without
  claiming anything about meaning.
- **Different text yields a different vector**, up to hash collision — including text made
  entirely of punctuation or emoji.

Windows rather than words, because this never has to decide what a word is. That question has no
cheap answer: it needs case folding, Unicode normalization, a rule per script, and a dictionary
for the ones written without spaces — and each of those is a table that can disagree between two
machines, which would make a vector depend on where it was computed. A window has no opinion, so
all three properties hold identically for `the login flow`, for `登录流程`, for `!!!`, and for
`🔥🔥`. A word-based vectorizer collapses the last two to one empty vector apiece.

Two consequences to know:

- **Nothing is folded.** `Login` and `login` are different text and get different vectors, as do
  the two Unicode spellings of `café`. The vector is a pure function of the exact string.
- **The empty string is the one text with no windows**, and gets an arbitrary unit vector rather
  than zeroes, so a consumer gets something usable instead of `NaN`s.

**`data` entries are returned deliberately out of order.** Each carries its own `index`, and a
consumer that trusts array position instead of that field fails here rather than passing by
luck. This is a feature of the contract, not an implementation detail — do not "fix" it.

### `POST /v1/chat/completions`

Accepts `{ model, messages, tools?, temperature, ... }`. Unknown models are rejected with `400`.
Everything else comes from the scenario registered for the request's scope:

| Situation | Response |
| --- | --- |
| An exchange matches | Its outcome — `text`, `toolCall`, or `error` |
| None matches, `default` present | The default outcome |
| None matches, no `default` | `501`, describing the request that found no match |
| No scenario for this scope | `501`, naming the scope and how to register one |

**`501` and not `404`, deliberately.** Clients commonly read `404` from a completion as "that
model does not exist", which would make a missing scenario indistinguishable from a missing
model. `501` is also outside the conventional retryable set (429/502/503/504), so it surfaces on
the first attempt rather than after a backoff sequence.

A `toolCall` outcome emits the call whether or not the request offered that tool. To assert the
enablement path — that a tool disabled in your application is never called — pair it with the
`toolOffered` matcher, which is what makes the exchange conditional on the offer.

## Determinism, and the one thing that is remembered

A response is a pure function of **the request plus the scenario registered for its scope**.
No counters, no ordering between requests, no dependence on a clock — the TTL governs eviction
only, never a response body.

Scenarios are the single exception to holding nothing, and they are scoped precisely so that
exception cannot leak: a scenario is reachable only by requests carrying its key, so tests
running in parallel cannot observe or disturb each other's. Everything else — model listing,
embeddings — remembers nothing at all.

Keep it that way. A counter, a per-run script, or any state keyed on something other than the
scope would couple unrelated tests through this service, and the resulting flake would look like
a bug in your application rather than in the harness.

## HTTP transport

This service speaks plain HTTP, so nothing has to be arranged for a stack to reach it. Your
application's base-URL validation has to permit `http://` for an in-cluster endpoint.

The test inference service is intended for a local or isolated test network. It does not provide TLS termination;
deployments that need TLS place it behind an appropriate proxy.

## Development

```sh
npm ci
npm run check
npm test
npm run test:package
```

`test:package` creates the publish tarball, installs it in a clean temporary project, imports the
public client API, starts the installed `test-inference` executable, and checks its health endpoint.

## Publishing

Releases are published as public npm packages by `.github/workflows/publish.yaml`. Before the first
release, configure npm trusted publishing for package `@canonical/test-inference`, repository
`canonical/test_inference`, and workflow
`publish.yaml`. Then push a `v1.0.0` tag and publish the matching GitHub release. The workflow rejects
a release whose tag does not match `package.json`, runs all checks and package smoke tests, and
publishes with npm provenance.

## Module layout

| File | Role |
| --- | --- |
| `src/server.ts` | Routing and the listener. The scenario routes are the only control surface |
| `src/chat.ts` | `POST /v1/chat/completions` — resolves a scenario, or `501` |
| `src/embeddings.ts` | `POST /v1/embeddings` — the character-window vectorizer |
| `src/models.ts` | `GET /v1/models` — the advertised catalog |
| `src/scenarios.ts` | The scenario store, its validator, and outcome resolution |
| `src/http.ts` | Body reading, responses, and the credential rule |
| `src/util.ts` | Hashing and token estimation, shared by chat and embeddings |
| `src/client.ts` | The typed scenario client a test suite imports |
| `dist/` | Compiled JavaScript and declarations used by Node and package consumers |

---

## Appendix: how Athena uses it

Athena is this package's first consumer, and its wiring is a worked example of everything above.
The test inference service lives in its own repository and is published to npm.
Athena keeps `"@canonical/test-inference": "1.0.0"` as a development dependency, and specs
`import … from "@canonical/test-inference"` like any other dependency. Nothing imports it by path.

- **Compose.** The `test-inference` service in `compose.yaml` runs the dependency installed in
  Athena's image; `athena` waits on its health check, and
  `testing/playwright-global-setup.ts` starts it alongside `postgres` and `dex`.
- **Configuration.** Specs create a `provider` record through the UI whose `baseUrl` is
  `http://test-inference:8080/v1` and whose `apiKey` is the scope key. `modelEndpointUrl`
  (`src/components/utilities/zod.utilities.ts`) and the `providerBaseUrlScheme` CHECK both
  permit HTTP, which is what makes that possible.
- **Binding.** `testing/playwright/inference.ts` binds the loopback address and mints scope keys;
  `testing/playwright/test.ts` exposes a `runnableLoop` fixture whose provider carries the scope
  and an `inference` fixture bound to it, so a spec never names a key by hand.
- **Setup declares its own answers.** `addProviderToLoop` registers only
  `{ when: { userMessageEquals: "." } }` — the model-validation probe its own UI flow causes —
  and no `default`. The code that *causes* a completion is the code that declares it, so a spec
  inherits no opinion about its own turns and an unexpected request during setup is still a
  `501`. This is why `userMessageEquals` is exact: `.` as a substring would match everything.
- **Standing.** `docs/testing-standards.md` §4 prohibits doubles inside the spec or the
  application process, and its *Stack services* section permits a dependency reached through
  ordinary configuration — including one configured per spec. Its other load-bearing rule is the
  one repeated above: assert on effects, not on a configured response's wording.
- **The trailing-prompt trap** described in *Matching a multi-turn loop* is real here:
  `task.iteratorPrimary.ts:549` and `:435` both append a synthetic `user` message.
  `src/components/tool/tool.spec.ts` is the worked example of matching around it.
