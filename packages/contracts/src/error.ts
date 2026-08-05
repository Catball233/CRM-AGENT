import { z } from "zod";
import { ContractVersionSchema, IdSchema } from "./common";

export const ApiErrorCodeSchema = z.enum([
  "INVALID_REQUEST",
  "CONVERSATION_NOT_FOUND",
  "TURN_NOT_FOUND",
  "CONVERSATION_BUSY",
  "IDEMPOTENCY_KEY_REUSED",
  "TURN_RETRY_REQUIRED",
  "TURN_NOT_RETRYABLE",
  "AI_OUTPUT_INVALID",
  "MODEL_UNAVAILABLE",
  "KNOWLEDGE_UNAVAILABLE",
  "PERSISTENCE_ERROR",
  "INTERNAL_ERROR",
  "INTERRUPTED_BY_RESTART",
]);

export const ApiErrorBodySchema = z
  .object({
    code: ApiErrorCodeSchema,
    message: z.string().min(1).max(1_000),
    retryable: z.boolean(),
    request_id: IdSchema,
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;

export const ApiErrorSchema = z
  .object({
    contract_version: ContractVersionSchema,
    error: ApiErrorBodySchema,
  })
  .strict();
export type ApiError = z.infer<typeof ApiErrorSchema>;
