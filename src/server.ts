#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { handleChatCompletion } from "./chat.js";
import { handleEmbeddings } from "./embeddings.js";
import { authorize, logRequest, readBody, respond, respondError } from "./http.js";
import { handleModelList } from "./models.js";
import { deleteScenario, putScenario, validateScenario } from "./scenarios.js";
import type { InferenceScenario } from "./types.js";

const port = Number.parseInt(process.env.PORT ?? `8080`, 10);
const scenarioPrefix = `/_mock/scenarios/`;

const decodeScope = (encoded: string): string | null => {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
};

const handleScenarioRoute = async (request: IncomingMessage, response: ServerResponse, scope: string): Promise<void> => {
  if (request.method === `DELETE`) {
    deleteScenario(scope);
    return respond(response, 200, { scope, deleted: true });
  }

  if (request.method !== `PUT`) {
    return respondError(response, 405, `Use PUT or DELETE on a scenario.`);
  }

  const body = await readBody(request);

  if (body === null) {
    return respondError(response, 400, `Scenario body must be valid JSON.`);
  }

  const invalid = validateScenario(body);

  if (invalid) {
    return respondError(response, 400, invalid);
  }

  const scenario = body as InferenceScenario;
  putScenario(scope, scenario);
  logRequest(`scenario`, { scope, exchanges: scenario.exchanges?.length ?? 0 });
  return respond(response, 200, { scope, stored: true });
};

const route = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
  const url = new URL(request.url ?? `/`, `http://localhost`);
  const path = url.pathname.replace(/\/+$/u, ``) || `/`;

  if (path === `/health`) {
    return respond(response, 200, { status: `ok` });
  }

  // Specs call this directly rather than through the application, so it carries no bearer.
  if (path.startsWith(scenarioPrefix)) {
    const encoded = path.slice(scenarioPrefix.length);
    const scope = decodeScope(encoded);

    if (scope === null) {
      return respondError(response, 400, `Scope "${encoded}" is not valid percent-encoded text.`);
    }

    return handleScenarioRoute(request, response, scope);
  }

  const auth = authorize(request);

  if (!auth.ok) {
    return respondError(response, 401, auth.message);
  }

  if (request.method === `GET` && path.endsWith(`/models`)) {
    return handleModelList(response);
  }

  if (request.method !== `POST`) {
    return respondError(response, 405, `Method not allowed.`);
  }

  const body = await readBody(request);

  if (body === null) {
    return respondError(response, 400, `Request body must be valid JSON.`);
  }

  if (path.endsWith(`/embeddings`)) {
    return handleEmbeddings(body, response);
  }

  if (path.endsWith(`/chat/completions`)) {
    return handleChatCompletion(body, response, auth.scope);
  }

  return respondError(response, 404, `Unsupported path: ${path}.`);
};

const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
  try {
    return await route(request, response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logRequest(`error`, { method: request.method, path: request.url, message });

    if (response.headersSent) {
      response.destroy();
      return;
    }

    return respondError(response, 500, `Inference service failed to handle this request: ${message}`);
  }
};

export const createInferenceService = () => createServer(handleRequest);

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  createInferenceService().listen(port, () => {
    process.stdout.write(`inference: http on ${port}\n`);
  });
}
