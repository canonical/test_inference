import type { ChatMessage, InferenceMatcher, InferenceOutcome, InferenceScenario } from "./types.js";
import { isPlainObject } from "./types.js";
import { readMessageText } from "./util.js";

type ScenarioEntry = { scenario: InferenceScenario; expiresAt: number };
type ScenarioContext = { model: string; messages: ChatMessage[]; toolNames: Set<string> };
type ResolvedOutcome = { outcome: InferenceOutcome; source: string };

const scenarios = new Map<string, ScenarioEntry>();
const scenarioTtlMs = 10 * 60 * 1000;

const matcherKeys = new Set<keyof InferenceMatcher>([`model`, `lastMessageRole`, `userMessageEquals`, `messagesContain`, `toolOffered`]);
const outcomeKeys = new Set([`text`, `toolCall`, `error`]);
const errorKeys = new Set([`message`]);

/** Validates on write so a typo in a spec fails loudly instead of silently never matching. */
export const validateScenario = (scenario: unknown): string | null => {
  if (!isPlainObject(scenario)) {
    return `Scenario must be an object.`;
  }

  const exchanges = scenario.exchanges ?? [];

  if (!Array.isArray(exchanges)) {
    return `exchanges must be an array.`;
  }

  for (const [index, exchange] of exchanges.entries()) {
    if (!isPlainObject(exchange)) {
      return `exchanges[${index}] must be an object.`;
    }

    const when = exchange.when;

    if (when !== undefined && !isPlainObject(when)) {
      return `exchanges[${index}].when must be an object.`;
    }

    for (const key of Object.keys(when ?? {})) {
      if (!matcherKeys.has(key as keyof InferenceMatcher)) {
        return `exchanges[${index}].when has unknown matcher "${key}". Known: ${[...matcherKeys].join(`, `)}.`;
      }
    }

    const outcomeError = validateOutcome(exchange.outcome, `exchanges[${index}].outcome`);

    if (outcomeError) {
      return outcomeError;
    }
  }

  return scenario.default === undefined ? null : validateOutcome(scenario.default, `default`);
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

const lastUserMessage = (messages: ChatMessage[]): ChatMessage | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message?.role === `user`) {
      return message;
    }
  }

  return undefined;
};

const matches = (when: InferenceMatcher | undefined, context: ScenarioContext): boolean => {
  if (!when) {
    return true;
  }

  if (when.model && context.model !== when.model) {
    return false;
  }

  if (when.userMessageEquals !== undefined) {
    const userMessage = lastUserMessage(context.messages);

    if (!userMessage || readMessageText(userMessage) !== when.userMessageEquals) {
      return false;
    }
  }

  if (when.lastMessageRole && context.messages.at(-1)?.role !== when.lastMessageRole) {
    return false;
  }

  if (when.messagesContain && !context.messages.some((message) => readMessageText(message).toLowerCase().includes(when.messagesContain?.toLowerCase() ?? ``))) {
    return false;
  }

  if (when.toolOffered && !context.toolNames.has(when.toolOffered)) {
    return false;
  }

  return true;
};

export const resolveOutcome = (scenario: InferenceScenario, context: ScenarioContext): ResolvedOutcome | null => {
  for (const [index, exchange] of (scenario.exchanges ?? []).entries()) {
    if (matches(exchange.when, context)) {
      return { outcome: exchange.outcome, source: `exchange[${index}]` };
    }
  }

  return scenario.default ? { outcome: scenario.default, source: `default` } : null;
};
