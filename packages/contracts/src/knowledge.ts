import { z } from "zod";
import { ContractVersionSchema, IdSchema, IsoDateTimeSchema } from "./common";

export const KnowledgeSearchRequestSchema = z
  .object({
    contract_version: ContractVersionSchema,
    conversation_id: IdSchema,
    turn_id: IdSchema,
    query: z.string().min(1).max(2_000),
    topics: z.array(z.string().min(1).max(100)).min(1).max(10),
    filters: z
      .object({
        city: z.string().min(1).optional(),
        category: z.array(z.string().min(1)).max(20).optional(),
        effective_at: IsoDateTimeSchema.optional(),
      })
      .strict(),
    max_results: z.number().int().min(1).max(20),
  })
  .strict();

export const RuleCandidateSchema = z
  .object({
    rule_id: z.string().min(1).max(100),
    evidence_id: IdSchema,
  })
  .strict();

export const KnowledgeEvidenceSchema = z
  .object({
    contract_version: ContractVersionSchema,
    evidence_id: IdSchema,
    knowledge_base_id: z.string().min(1).max(200),
    document_id: z.string().min(1).max(200),
    document_version: z.string().min(1).max(100),
    chunk_id: z.string().min(1).max(200),
    title: z.string().min(1).max(500),
    excerpt: z.string().min(1).max(2_000),
    score: z.number().min(0).max(1),
    metadata: z
      .object({
        category: z.string().min(1).optional(),
        city: z.string().min(1).optional(),
        effective_from: IsoDateTimeSchema.optional(),
        effective_to: IsoDateTimeSchema.optional(),
      })
      .strict(),
    candidate_rule_ids: z.array(z.string().min(1).max(100)).max(50),
  })
  .strict();
export type KnowledgeEvidence = z.infer<typeof KnowledgeEvidenceSchema>;

export const KnowledgeSearchResultSchema = z
  .object({
    contract_version: ContractVersionSchema,
    evidence: z.array(KnowledgeEvidenceSchema).max(20),
    rule_candidates: z.array(RuleCandidateSchema).max(50),
    empty_reason: z
      .enum(["no_match", "below_threshold", "provider_unavailable"])
      .optional(),
    provider_request_id: z.string().min(1).max(200).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const evidenceIds = new Set(value.evidence.map((item) => item.evidence_id));
    for (const [index, candidate] of value.rule_candidates.entries()) {
      if (!evidenceIds.has(candidate.evidence_id)) {
        context.addIssue({
          code: "custom",
          path: ["rule_candidates", index, "evidence_id"],
          message: "rule candidate must reference evidence in the same result",
        });
      }
    }
  });
export type KnowledgeSearchResult = z.infer<typeof KnowledgeSearchResultSchema>;
