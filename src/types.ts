export type JsonObject = Record<string, unknown>;

export const isPlainObject = (value: unknown): value is JsonObject => Boolean(value) && typeof value === `object` && !Array.isArray(value);

export type InferenceOutcome = { text: string } | { toolCall: { name: string; arguments?: Record<string, unknown> } } | { error: { message?: string } };

/** Exact user prompts mapped to ordered assistant responses. */
export type InferenceScenario = Record<string, readonly [InferenceOutcome, ...InferenceOutcome[]]>;

export type ScenarioClient = {
  register: (scope: string, scenario: InferenceScenario) => Promise<void>;
  remove: (scope: string) => Promise<void>;
};

export type ChatMessage = {
  role: string;
  content: string | null;
};
