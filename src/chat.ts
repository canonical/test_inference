import type { ServerResponse } from "node:http";
import { logRequest, respond, respondError } from "./http.js";
import { findChatModel } from "./models.js";
import { getScenario, resolveOutcome } from "./scenarios.js";
import type { ChatMessage, ChatTool, JsonObject } from "./types.js";
import { isPlainObject } from "./types.js";
import { estimateTokens, hashToken, readMessageText } from "./util.js";

const shapeAssistantText = (messages: ChatMessage[], text: string): string => {
  const wantsJsonContent = messages.some((message) => readMessageText(message).includes(`JSON object with key content`));
  return wantsJsonContent ? JSON.stringify({ content: text }) : text;
};

const describeRequest = (model: string, messages: ChatMessage[]): string => `model=${model} lastMessageRole=${messages.at(-1)?.role ?? `(none)`} messages=${messages.length}`;

export const handleChatCompletion = (body: unknown, response: ServerResponse, scope: string): void => {
  if (!isPlainObject(body)) {
    return respondError(response, 400, `Request body must be an object.`);
  }

  const model = typeof body.model === `string` ? body.model : ``;

  if (!findChatModel(model)) {
    return respondError(response, 400, `Unknown chat model: ${model || `(none)`}.`);
  }

  const scenario = getScenario(scope);

  if (!scenario) {
    logRequest(`chat`, { scope, model, match: `unconfigured` });
    return respondError(response, 501, `No scenario registered for scope "${scope}". This service has no default behavior — register one with PUT /_mock/scenarios/${encodeURIComponent(scope)} before the request that needs it.`);
  }

  const messages = (Array.isArray(body.messages) ? body.messages : []).filter(isPlainObject).map((message) => ({
    role: typeof message.role === `string` ? message.role : ``,
    content: typeof message.content === `string` || message.content === null ? message.content : ``,
  })) as ChatMessage[];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const toolNames = new Set(
    tools.filter(isPlainObject).map((tool) => (isPlainObject(tool.function) ? tool.function.name : undefined)).filter((name): name is string => typeof name === `string`),
  );
  const resolved = resolveOutcome(scenario, { model, messages, toolNames });

  if (!resolved) {
    logRequest(`chat`, { scope, model, match: `unmatched` });
    return respondError(response, 501, `Scenario for scope "${scope}" has no exchange matching this request and no default outcome (${describeRequest(model, messages)}).`);
  }

  const { outcome, source } = resolved;
  logRequest(`chat`, { scope, model, match: source });

  if (`error` in outcome) {
    return respondError(response, 502, outcome.error.message ?? `Scenario error.`);
  }

  const message = `toolCall` in outcome
    ? {
        role: `assistant`,
        content: null,
        tool_calls: [
          {
            id: `call_${hashToken(`${scope}:${source}`).toString(16)}`,
            type: `function`,
            function: { name: outcome.toolCall.name, arguments: JSON.stringify(outcome.toolCall.arguments ?? {}) },
          },
        ],
      }
    : { role: `assistant`, content: shapeAssistantText(messages, outcome.text) };

  const promptTokens = messages.reduce((total, current) => total + estimateTokens(readMessageText(current)), 0);

  return respond(response, 200, {
    id: `chatcmpl-${hashToken(JSON.stringify(messages)).toString(16)}`,
    object: `chat.completion`,
    model,
    choices: [{ index: 0, finish_reason: `toolCall` in outcome ? `tool_calls` : `stop`, message }],
    usage: { prompt_tokens: promptTokens, completion_tokens: 16, total_tokens: promptTokens + 16, cost: 0 },
  });
};
