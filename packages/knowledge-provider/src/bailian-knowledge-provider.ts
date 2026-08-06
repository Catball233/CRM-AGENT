import { createHash } from "node:crypto";
import {
  CONTRACT_VERSION,
  KnowledgeEvidenceSchema,
  KnowledgeSearchRequestSchema,
  KnowledgeSearchResultSchema,
  type KnowledgeEvidence,
} from "@crm-agent/contracts";
import { z } from "zod";
import {
  KnowledgeProviderError,
  type KnowledgeProvider,
  type KnowledgeSearchRequest,
  type KnowledgeSearchResult,
} from "./types";

const DEFAULT_DOCUMENT_VERSION = "0.2.0";
const DEFAULT_MIN_SCORE = 0.5;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY_DELAY_MS = 250;
const MAX_RESPONSE_CHARACTERS = 5_000_000;

const BailianMetadataSchema = z
  .object({
    doc_id: z.string().min(1).max(500),
    doc_name: z.string().min(1).max(1_000).optional(),
    title: z.string().min(1).max(1_000).optional(),
    hier_title: z.string().min(1).max(1_000).optional(),
    content: z.string().min(1).optional(),
    pipeline_id: z.string().min(1).max(500),
    _id: z.string().min(1).max(500).optional(),
    nid: z.string().min(1).max(500).optional(),
    category: z.string().min(1).optional(),
    city: z.string().min(1).optional(),
    effective_from: z.string().min(1).optional(),
    effective_to: z.string().min(1).optional(),
    rule_id: z.union([z.string(), z.array(z.string())]).optional(),
    rule_ids: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .passthrough();

const BailianNodeSchema = z
  .object({
    score: z.number().min(0).max(1),
    text: z.string().min(1),
    metadata: BailianMetadataSchema,
  })
  .passthrough();

const BailianSearchEnvelopeSchema = z
  .object({
    code: z.string(),
    status_code: z.number().int(),
    status: z.string(),
    success: z.boolean(),
    message: z.string(),
    request_id: z.string().min(1).max(500),
    data: z
      .object({
        total: z.number().int().nonnegative(),
        nodes: z.array(BailianNodeSchema).max(100),
        cost_time: z.number().int().nonnegative(),
      })
      .passthrough(),
  })
  .passthrough();

type BailianNode = z.infer<typeof BailianNodeSchema>;

interface BailianKnowledgeProviderConfig {
  apiKey: string;
  workspaceId: string;
  searchAgentId: string;
  knowledgeBaseId: string;
  documentVersion: string;
  minScore: number;
  timeoutMs: number;
  retryDelayMs: number;
  agentVersion?: string | undefined;
  fetch: typeof globalThis.fetch;
  sleep: (delayMs: number) => Promise<void>;
}

export interface BailianKnowledgeProviderOptions {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  fetch?: typeof globalThis.fetch;
  sleep?: (delayMs: number) => Promise<void>;
  timeoutMs?: number;
  retryDelayMs?: number;
}

class AttemptFailure extends Error {
  readonly retryable: boolean;
  readonly status: number | undefined;
  readonly providerRequestId: string | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(options: {
    retryable: boolean;
    status?: number | undefined;
    providerRequestId?: string | undefined;
    retryAfterMs?: number | undefined;
    cause?: unknown;
  }) {
    super("Knowledge provider request failed.", { cause: options.cause });
    this.name = "AttemptFailure";
    this.retryable = options.retryable;
    this.status = options.status;
    this.providerRequestId = options.providerRequestId;
    this.retryAfterMs = options.retryAfterMs;
  }
}

const configError = (message: string, cause?: unknown) =>
  new KnowledgeProviderError("KNOWLEDGE_CONFIG_INVALID", message, { cause });

const requiredEnv = (
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  name: string,
) => {
  const value = env[name]?.trim();
  if (!value) throw configError(`${name} is required in the server environment.`);
  return value;
};

const validateIdentifier = (name: string, value: string) => {
  if (value.length > 500 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw configError(`${name} contains unsupported characters.`);
  }
  return value;
};

const parseNumberEnv = (
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  name: string,
  fallback: number,
) => {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw configError(`${name} must be a finite number.`);
  return value;
};

const requireInteger = (name: string, value: number, minimum: number, maximum: number) => {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw configError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
};

const defaultSleep = (delayMs: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });

const getProviderRequestId = (response: Response) =>
  response.headers.get("x-request-id") ?? response.headers.get("x-acs-request-id") ?? undefined;

const parseRetryAfterMs = (response: Response) => {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);

  const date = Date.parse(raw);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
};

const isAbortError = (error: unknown) =>
  error instanceof Error && error.name === "AbortError";

const truncate = (value: string, maximumCharacters: number) =>
  Array.from(value.trim()).slice(0, maximumCharacters).join("");

const stableEvidenceId = (input: KnowledgeSearchRequest, node: BailianNode) => {
  const digest = createHash("sha256")
    .update(
      [
        input.conversation_id,
        input.turn_id,
        node.metadata.pipeline_id,
        node.metadata.doc_id,
        node.metadata._id ?? node.metadata.nid ?? "",
      ].join("\u0000"),
    )
    .digest();
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

const normalizeRuleIds = (value: unknown) => {
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return values
    .flatMap((item) => item.split(/[，,;；\s]+/u))
    .map((item) => item.trim())
    .filter((item) => /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(item));
};

const extractRuleIds = (node: BailianNode) => {
  const ids = new Set<string>([
    ...normalizeRuleIds(node.metadata.rule_id),
    ...normalizeRuleIds(node.metadata.rule_ids),
  ]);
  const source = `${node.text}\n${node.metadata.content ?? ""}`;
  const pattern = /(?:rule_id|规则\s*(?:ID|编号))\s*["']?\s*[:：=]\s*["']?([A-Za-z0-9][A-Za-z0-9._/-]{0,99})/giu;
  for (const match of source.matchAll(pattern)) {
    if (match[1]) ids.add(match[1]);
  }
  return [...ids].slice(0, 50);
};

const optionalMetadata = (node: BailianNode) => {
  const metadata: KnowledgeEvidence["metadata"] = {
    ...(node.metadata.category ? { category: node.metadata.category } : {}),
    ...(node.metadata.city ? { city: node.metadata.city } : {}),
    ...(node.metadata.effective_from
      ? { effective_from: node.metadata.effective_from }
      : {}),
    ...(node.metadata.effective_to ? { effective_to: node.metadata.effective_to } : {}),
  };
  return metadata;
};

const isApplicable = (
  evidence: KnowledgeEvidence,
  filters: KnowledgeSearchRequest["filters"],
) => {
  if (filters.city && evidence.metadata.city && evidence.metadata.city !== filters.city) return false;
  if (
    filters.category &&
    evidence.metadata.category &&
    !filters.category.includes(evidence.metadata.category)
  ) {
    return false;
  }
  if (filters.effective_at) {
    const effectiveAt = Date.parse(filters.effective_at);
    if (
      evidence.metadata.effective_from &&
      Date.parse(evidence.metadata.effective_from) > effectiveAt
    ) {
      return false;
    }
    if (evidence.metadata.effective_to && Date.parse(evidence.metadata.effective_to) < effectiveAt) {
      return false;
    }
  }
  return true;
};

export class BailianKnowledgeProvider implements KnowledgeProvider {
  constructor(private readonly config: BailianKnowledgeProviderConfig) {}

  async search(input: KnowledgeSearchRequest): Promise<KnowledgeSearchResult> {
    const parsedInput = KnowledgeSearchRequestSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new KnowledgeProviderError(
        "KNOWLEDGE_REQUEST_INVALID",
        "Knowledge search request does not satisfy the public contract.",
        { cause: parsedInput.error },
      );
    }

    let lastRequestId: string | undefined;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        return await this.requestAttempt(parsedInput.data);
      } catch (error) {
        const failure =
          error instanceof AttemptFailure
            ? error
            : new AttemptFailure({ retryable: false, cause: error });
        lastRequestId = failure.providerRequestId ?? lastRequestId;
        if (!failure.retryable || attempt === 2) {
          return this.unavailable(lastRequestId);
        }
        await this.config.sleep(failure.retryAfterMs ?? this.config.retryDelayMs);
      }
    }

    return this.unavailable(lastRequestId);
  }

  private async requestAttempt(input: KnowledgeSearchRequest): Promise<KnowledgeSearchResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    let response: Response;

    try {
      response = await this.config.fetch(
        `https://${this.config.workspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/indices/knowledge/search`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            agent_id: this.config.searchAgentId,
            query: input.query,
            images: [],
            ...(this.config.agentVersion ? { agent_version: this.config.agentVersion } : {}),
          }),
          signal: controller.signal,
        },
      );
    } catch (error) {
      clearTimeout(timeout);
      throw new AttemptFailure({
        retryable: false,
        cause: error,
      });
    }

    try {
      if (!response.ok) {
        throw new AttemptFailure({
          retryable: response.status === 429 || response.status >= 500,
          status: response.status,
          providerRequestId: getProviderRequestId(response),
          retryAfterMs: parseRetryAfterMs(response),
        });
      }

      let raw: string;
      try {
        raw = await response.text();
      } catch (error) {
        throw new AttemptFailure({
          retryable: false,
          providerRequestId: getProviderRequestId(response),
          cause: error,
        });
      }
      if (raw.length > MAX_RESPONSE_CHARACTERS) {
        throw new AttemptFailure({
          retryable: false,
          providerRequestId: getProviderRequestId(response),
        });
      }

      let unknownEnvelope: unknown;
      try {
        unknownEnvelope = JSON.parse(raw);
      } catch (error) {
        throw new AttemptFailure({
          retryable: false,
          providerRequestId: getProviderRequestId(response),
          cause: error,
        });
      }

      const envelope = BailianSearchEnvelopeSchema.safeParse(unknownEnvelope);
      if (
        !envelope.success ||
        !envelope.data.success ||
        envelope.data.status_code !== 200 ||
        envelope.data.status !== "SUCCESS" ||
        envelope.data.code !== "Success"
      ) {
        throw new AttemptFailure({
          retryable: false,
          providerRequestId:
            envelope.success ? envelope.data.request_id : getProviderRequestId(response),
          cause: envelope.success ? undefined : envelope.error,
        });
      }

      return this.mapResult(input, envelope.data);
    } finally {
      clearTimeout(timeout);
    }
  }

  private mapResult(
    input: KnowledgeSearchRequest,
    envelope: z.infer<typeof BailianSearchEnvelopeSchema>,
  ): KnowledgeSearchResult {
    if (envelope.data.nodes.length === 0) {
      return KnowledgeSearchResultSchema.parse({
        contract_version: CONTRACT_VERSION,
        evidence: [],
        rule_candidates: [],
        empty_reason: "no_match",
        provider_request_id: truncate(envelope.request_id, 200),
      });
    }

    const confidentNodes = envelope.data.nodes.filter((node) => node.score >= this.config.minScore);
    if (confidentNodes.length === 0) {
      return KnowledgeSearchResultSchema.parse({
        contract_version: CONTRACT_VERSION,
        evidence: [],
        rule_candidates: [],
        empty_reason: "below_threshold",
        provider_request_id: truncate(envelope.request_id, 200),
      });
    }

    const evidence = confidentNodes
      .map((node) => this.mapEvidence(input, node))
      .filter((item) => isApplicable(item, input.filters))
      .sort((left, right) => right.score - left.score)
      .slice(0, input.max_results);

    if (evidence.length === 0) {
      return KnowledgeSearchResultSchema.parse({
        contract_version: CONTRACT_VERSION,
        evidence: [],
        rule_candidates: [],
        empty_reason: "no_match",
        provider_request_id: truncate(envelope.request_id, 200),
      });
    }

    const ruleEvidence = new Map<string, KnowledgeEvidence[]>();
    for (const item of evidence) {
      for (const ruleId of item.candidate_rule_ids) {
        ruleEvidence.set(ruleId, [...(ruleEvidence.get(ruleId) ?? []), item]);
      }
    }

    const ruleCandidates = [...ruleEvidence.entries()]
      .filter(([, items]) => {
        const sources = new Set(
          items.map((item) => `${item.knowledge_base_id}\u0000${item.document_id}\u0000${item.document_version}`),
        );
        return sources.size === 1;
      })
      .map(([ruleId, items]) => ({
        rule_id: ruleId,
        evidence_id: items.sort((left, right) => right.score - left.score)[0]!.evidence_id,
      }))
      .slice(0, 50);

    return KnowledgeSearchResultSchema.parse({
      contract_version: CONTRACT_VERSION,
      evidence,
      rule_candidates: ruleCandidates,
      provider_request_id: truncate(envelope.request_id, 200),
    });
  }

  private mapEvidence(input: KnowledgeSearchRequest, node: BailianNode): KnowledgeEvidence {
    if (node.metadata.pipeline_id !== this.config.knowledgeBaseId) {
      throw new AttemptFailure({ retryable: false });
    }
    const chunkId = node.metadata._id ?? node.metadata.nid;
    if (!chunkId) throw new AttemptFailure({ retryable: false });

    const excerpt = truncate(node.metadata.content ?? node.text, 2_000);
    const title = truncate(
      node.metadata.title ?? node.metadata.hier_title ?? node.metadata.doc_name ?? "知识切片",
      500,
    );
    if (!excerpt || !title) throw new AttemptFailure({ retryable: false });

    const parsed = KnowledgeEvidenceSchema.safeParse({
      contract_version: CONTRACT_VERSION,
      evidence_id: stableEvidenceId(input, node),
      knowledge_base_id: node.metadata.pipeline_id,
      document_id: truncate(node.metadata.doc_id, 200),
      document_version: this.config.documentVersion,
      chunk_id: truncate(chunkId, 200),
      title,
      excerpt,
      score: node.score,
      metadata: optionalMetadata(node),
      candidate_rule_ids: extractRuleIds(node),
    });
    if (!parsed.success) {
      throw new AttemptFailure({ retryable: false, cause: parsed.error });
    }
    return parsed.data;
  }

  private unavailable(providerRequestId?: string): KnowledgeSearchResult {
    return KnowledgeSearchResultSchema.parse({
      contract_version: CONTRACT_VERSION,
      evidence: [],
      rule_candidates: [],
      empty_reason: "provider_unavailable",
      ...(providerRequestId
        ? { provider_request_id: truncate(providerRequestId, 200) }
        : {}),
    });
  }
}

export const createBailianKnowledgeProviderFromEnv = (
  options: BailianKnowledgeProviderOptions = {},
): KnowledgeProvider => {
  const env = options.env ?? process.env;
  const apiKey = requiredEnv(env, "DASHSCOPE_API_KEY");
  const workspaceId = validateIdentifier(
    "BAILIAN_WORKSPACE_ID",
    requiredEnv(env, "BAILIAN_WORKSPACE_ID"),
  );
  const searchAgentId = validateIdentifier(
    "BAILIAN_KNOWLEDGE_SEARCH_AGENT_ID",
    requiredEnv(env, "BAILIAN_KNOWLEDGE_SEARCH_AGENT_ID"),
  );
  const knowledgeBaseId = validateIdentifier(
    "BAILIAN_KNOWLEDGE_BASE_ID",
    requiredEnv(env, "BAILIAN_KNOWLEDGE_BASE_ID"),
  );
  const documentVersion =
    env.BAILIAN_KNOWLEDGE_DOCUMENT_VERSION?.trim() || DEFAULT_DOCUMENT_VERSION;
  const minScore = parseNumberEnv(env, "BAILIAN_MIN_SCORE", DEFAULT_MIN_SCORE);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const agentVersion = env.BAILIAN_KNOWLEDGE_SEARCH_AGENT_VERSION?.trim() || undefined;

  if (documentVersion.length > 100) {
    throw configError("BAILIAN_KNOWLEDGE_DOCUMENT_VERSION must not exceed 100 characters.");
  }
  if (minScore < 0 || minScore > 1) {
    throw configError("BAILIAN_MIN_SCORE must be between 0 and 1.");
  }
  requireInteger("timeoutMs", timeoutMs, 1, 300_000);
  requireInteger("retryDelayMs", retryDelayMs, 0, 60_000);

  return new BailianKnowledgeProvider({
    apiKey,
    workspaceId,
    searchAgentId,
    knowledgeBaseId,
    documentVersion,
    minScore,
    timeoutMs,
    retryDelayMs,
    ...(agentVersion ? { agentVersion } : {}),
    fetch: options.fetch ?? globalThis.fetch,
    sleep: options.sleep ?? defaultSleep,
  });
};
