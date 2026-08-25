import type { IncomingMessage, ServerResponse } from "node:http";

const invalidKeyPrefix = `invalid-`;

export type Authorization = { ok: true; scope: string } | { ok: false; message: string };

export const readBody = async (request: IncomingMessage): Promise<unknown | null> => {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString(`utf8`));
  } catch {
    return null;
  }
};

export const respond = (response: ServerResponse, status: number, payload: unknown): void => {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "Content-Type": `application/json`, "Content-Length": Buffer.byteLength(body) });
  response.end(body);
};

export const respondError = (response: ServerResponse, status: number, message: string): void => respond(response, status, { error: { message, type: `invalid_request_error` } });

/** Any non-empty bearer is accepted; the token doubles as the scope key for scenarios. */
export const authorize = (request: IncomingMessage): Authorization => {
  const header = request.headers.authorization ?? ``;
  const token = header.startsWith(`Bearer `) ? header.slice(7).trim() : ``;

  if (token.length === 0) {
    return { ok: false, message: `Missing bearer credential.` };
  }

  if (token.startsWith(invalidKeyPrefix)) {
    return { ok: false, message: `Invalid credential.` };
  }

  return { ok: true, scope: token };
};

/** Keep request decisions visible when a spec fails. */
export const logRequest = (kind: string, fields: Record<string, unknown>): void => {
  const rendered = Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join(` `);
  process.stdout.write(`${kind} ${rendered}\n`);
};
