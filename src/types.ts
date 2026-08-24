export type JsonObject = Record<string, unknown>;

export const isPlainObject = (value: unknown): value is JsonObject => Boolean(value) && typeof value === `object` && !Array.isArray(value);

export type InferenceMatcherFields = {
  model?: string;
  /** The final message's role. */
  lastMessageRole?: `user` | `assistant` | `tool`;
  /** The most recent user message, matched exactly. */
  userMessageEquals?: string;
  /** A case-sensitive substring of any message. */
  messagesContain?: string;
  toolOffered?: string;
};

/** All optional; every supplied matcher must pass. An absent `when` always matches. */
export type InferenceMatcher = InferenceMatcherFields;

export type InferenceOutcome = { text: string } | { toolCall: { name: string; arguments?: Record<string, unknown> } } | { error: { message?: string } };

export type InferenceExchange = {
  when?: InferenceMatcher;
  outcome: InferenceOutcome;
};

/** First matching exchange wins; `default` answers anything matching none. */
export type InferenceScenario = {
  exchanges?: InferenceExchange[];
  default?: InferenceOutcome;
};

export type ScenarioClient = {
  register: (scope: string, scenario: InferenceScenario) => Promise<void>;
  remove: (scope: string) => Promise<void>;
};

export type ChatMessage = {
  role: string;
  content: string | null;
  tool_calls?: unknown[];
};

export type ChatTool = {
  function: { name: string };
};
