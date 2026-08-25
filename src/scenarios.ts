import type { ChatMessage, InferenceOutcome, InferenceScenario } from "./types.js";
import { isPlainObject } from "./types.js";
import { readMessageText } from "./util.js";

type ScenarioEntry = { scenario: InferenceScenario; expiresAt: number };
type ScenarioContext = { messages: ChatMessage[] };
type ResolvedOutcome = { outcome: InferenceOutcome; prompt: string; index: number; source: string };

const scenarios = new Map<string, ScenarioEntry>();
const scenarioTtlMs = 10 * 60 * 1000;

const outcomeKeys = new Set([`text`, `toolCall`, `error`]);
const errorKeys = new Set([`message`]);
const toolCallKeys = new Set([`name`, `arguments`]);

/** Validates on write so a typo in a spec fails loudly instead of silently never matching. */
export const validateScenario = (scenario: unknown): string | null => {
  if (!isPlainObject(scenario)) {
    return `Scenario must be an object.`;
  }

  for (const [prompt, outcomes] of Object.entries(scenario)) {
    if (!Array.isArray(outcomes) || outcomes.length === 0) {
      return `Scenario response chain for ${JSON.stringify(prompt)} must be a non-empty array.`;
    }

    for (const [index, outcome] of outcomes.entries()) {
      const outcomeError = validateOutcome(outcome, `Scenario response chain for ${JSON.stringify(prompt)}[${index}]`);

      if (outcomeError) {
        return outcomeError;
      }

    }
  }

  return null;
};

const validateOutcome = (outcome: unknown, label: string): string | null => {
  if (!isPlainObject(outcome)) {
    return `${label} must be an object.`;
  }

  const keys = Object.keys(outcome);
  const unknown = keys.find((key) => !outcomeKeys.has(key));

  if (unknown) {
    return `${label} has unknown key "${unknown}". Known: ${[...outcomeKeys].join(`, `)}.`;
  }

  if (keys.length !== 1) {
    return `${label} must have exactly one of: ${[...outcomeKeys].join(`, `)}.`;
  }

  if (`text` in outcome && typeof outcome.text !== `string`) {
    return `${label}.text must be a string.`;
  }

  if (`toolCall` in outcome) {
    if (!isPlainObject(outcome.toolCall) || typeof outcome.toolCall.name !== `string`) {
      return `${label}.toolCall.name is required.`;
    }

    const unknownToolCall = Object.keys(outcome.toolCall).find((key) => !toolCallKeys.has(key));

    if (unknownToolCall) {
      return `${label}.toolCall has unknown key "${unknownToolCall}". Known: ${[...toolCallKeys].join(`, `)}.`;
    }

    if (outcome.toolCall.arguments !== undefined && !isPlainObject(outcome.toolCall.arguments)) {
      return `${label}.toolCall.arguments must be an object.`;
    }
  }

  if (`error` in outcome) {
    if (!isPlainObject(outcome.error)) {
      return `${label}.error must be an object.`;
    }

    const unknownError = Object.keys(outcome.error).find((key) => !errorKeys.has(key));

    if (unknownError) {
      return `${label}.error has unknown key "${unknownError}". Known: message.`;
    }

    if (outcome.error.message !== undefined && typeof outcome.error.message !== `string`) {
      return `${label}.error.message must be a string.`;
    }
  }

  return null;
};

export const putScenario = (scope: string, scenario: InferenceScenario): void => {
  scenarios.set(scope, { scenario, expiresAt: Date.now() + scenarioTtlMs });
};

export const deleteScenario = (scope: string): boolean => scenarios.delete(scope);

/** Lazy expiry — no background timer, and the clock never influences a response body. */
export const getScenario = (scope: string): InferenceScenario | null => {
  const entry = scenarios.get(scope);

  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    scenarios.delete(scope);
    return null;
  }

  return entry.scenario;
};

const findPrompt = (scenario: InferenceScenario, messages: ChatMessage[]): { prompt: string; messageIndex: number } | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message?.role === `user` && Object.hasOwn(scenario, readMessageText(message))) {
      return { prompt: readMessageText(message), messageIndex: index };
    }
  }

  return null;
};

export const resolveOutcome = (scenario: InferenceScenario, context: ScenarioContext): ResolvedOutcome | null => {
  const match = findPrompt(scenario, context.messages);

  if (!match) {
    return null;
  }

  const outcomes = scenario[match.prompt];

  if (!outcomes) {
    return null;
  }

  const index = context.messages.slice(match.messageIndex + 1).filter((message) => message.role === `assistant`).length;
  const outcome = outcomes[index];
  return outcome ? { outcome, prompt: match.prompt, index, source: `prompt=${JSON.stringify(match.prompt)} response[${index}]` } : null;
};
