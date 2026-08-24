import { after, before } from "node:test";
import { createInferenceService } from "../server.js";

export type Service = { base: string };
export type JsonBody = Record<string, unknown>;
export type HttpResult = { status: number; body: JsonBody; headers: Headers };

export const startService = (): Service => {
  const state: Service = { base: `` };
  let server: ReturnType<typeof createInferenceService> | undefined;

  before(async () => {
    server = createInferenceService();
    await new Promise<void>((resolve, reject) => {
      server?.once(`error`, reject);
      server?.listen(0, `127.0.0.1`, resolve);
    });

    const address = server.address();

    if (!address || typeof address === `string`) {
      throw new Error(`Inference service did not bind a TCP port.`);
    }

    state.base = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  return state;
};

let counter = 0;
export const nextScope = (label: string): string => `${label}-${++counter}`;

const send = async (url: string, options?: RequestInit): Promise<HttpResult> => {
  const response = await fetch(url, options);
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? (JSON.parse(text) as JsonBody) : {}, headers: response.headers };
};

export const registerScenario = (base: string, scope: string, scenario: unknown): Promise<HttpResult> =>
  send(`${base}/_mock/scenarios/${encodeURIComponent(scope)}`, {
    method: `PUT`,
    headers: { "content-type": `application/json` },
    body: JSON.stringify(scenario),
  });

export const postChat = (base: string, scope: string, body: unknown): Promise<HttpResult> =>
  send(`${base}/v1/chat/completions`, {
    method: `POST`,
    headers: { authorization: `Bearer ${scope}`, "content-type": `application/json` },
    body: JSON.stringify(body),
  });

export const postEmbeddings = (base: string, body: unknown): Promise<HttpResult> =>
  send(`${base}/v1/embeddings`, {
    method: `POST`,
    headers: { authorization: `Bearer embeddings-scope`, "content-type": `application/json` },
    body: JSON.stringify(body),
  });

export const chatRequest = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  model: `deterministic-chat`,
  messages: [{ role: `user`, content: `hello` }],
  ...overrides,
});
