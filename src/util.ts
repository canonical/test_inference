import type { ChatMessage } from "./types.js";

/** Shared primitives. Deterministic by construction — no clock, no randomness, no locale. */
export const hashRange = (text: string, start: number, end: number): number => {
  let hash = 0x811c9dc5;

  for (let index = start; index < end; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash;
};

export const hashToken = (text: string): number => hashRange(text, 0, text.length);

/** Roughly four characters per token. `usage` is cosmetic, so an estimate is honest. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export const readMessageText = (message: Partial<ChatMessage> | undefined): string => (typeof message?.content === `string` ? message.content : ``);
