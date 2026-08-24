import type { InferenceOutcome, InferenceScenario, ScenarioClient } from "./types.js";

const scenarioUrl = (baseUrl: string, scope: string): string => `${String(baseUrl).replace(/\/+$/u, ``)}/_mock/scenarios/${encodeURIComponent(scope)}`;

export type { InferenceExchange, InferenceMatcher, InferenceOutcome, InferenceScenario, ScenarioClient } from "./types.js";

export const replies = (text: string): InferenceOutcome => ({ text });

export const callsTool = (name: string, args?: Record<string, unknown>): InferenceOutcome =>
  args === undefined ? { toolCall: { name } } : { toolCall: { name, arguments: args } };

export const fails = (message?: string): InferenceOutcome => (message === undefined ? { error: {} } : { error: { message } });

export const createScenarioClient = (baseUrl: string): ScenarioClient => ({
  register: async (scope: string, scenario: InferenceScenario): Promise<void> => {
    const response = await fetch(scenarioUrl(baseUrl, scope), {
      method: `PUT`,
      headers: { "Content-Type": `application/json` },
      body: JSON.stringify(scenario),
    });

    if (!response.ok) {
      throw new Error(`Inference scenario registration failed (${response.status}): ${await response.text()}`);
    }

  },

  remove: async (scope: string): Promise<void> => {
    const response = await fetch(scenarioUrl(baseUrl, scope), { method: `DELETE` });

    if (!response.ok) {
      throw new Error(`Inference scenario removal failed (${response.status}): ${await response.text()}`);
    }
  },
});
