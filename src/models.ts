import type { ServerResponse } from "node:http";
import { respond } from "./http.js";

export const chatModelCatalog = [{ id: `deterministic-chat`, name: `Deterministic Chat` }];

export const findChatModel = (id: string): (typeof chatModelCatalog)[number] | undefined => chatModelCatalog.find((model) => model.id === id);

/** Dimension is read from the name, so a spec can exercise widths without new advertisements. */
export const embeddingModelPattern = /^deterministic-embed-(\d+)$/u;

const advertisedEmbeddingModels = [`deterministic-embed-8`, `deterministic-embed-16`, `deterministic-embed-1536`];

export const handleModelList = (response: ServerResponse): void =>
  respond(response, 200, {
    object: `list`,
    data: [
      ...chatModelCatalog.map((model) => ({
        id: model.id,
        name: model.name,
        description: `Deterministic chat completions for the local and CI stacks.`,
        context_length: 32768,
        architecture: { modality: `text->text`, input_modalities: [`text`], output_modalities: [`text`] },
        pricing: { prompt: `0`, completion: `0`, request: `0`, image: `0` },
      })),
      ...advertisedEmbeddingModels.map((id) => ({
        id,
        name: `Deterministic Embeddings (${embeddingModelPattern.exec(id)?.[1]} dimensions)`,
        description: `Deterministic embeddings for the local and CI stacks.`,
        context_length: 8192,
        architecture: { modality: `text->embedding`, input_modalities: [`text`], output_modalities: [`embedding`] },
        pricing: { prompt: `0`, completion: `0`, request: `0`, image: `0` },
      })),
    ],
  });
