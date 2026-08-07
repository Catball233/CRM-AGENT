import { randomUUID } from "node:crypto";
import { HttpException, HttpStatus } from "@nestjs/common";
import { ApiErrorSchema } from "@crm-agent/contracts";

export class ApiException extends Error {
  constructor(
    readonly status: number,
    readonly body: ReturnType<typeof ApiErrorSchema.parse>,
  ) {
    super(body.error.message);
  }
}

export class ModelUnavailableError extends Error {
  constructor() {
    super("The configured model provider is unavailable");
  }
}

export class KnowledgeUnavailableError extends Error {
  constructor() {
    super("The configured knowledge provider is unavailable");
  }
}

export class PersistenceError extends Error {
  constructor() {
    super("Conversation persistence failed");
  }
}

export function apiError(
  status: number,
  code:
    | "INVALID_REQUEST"
    | "CONVERSATION_NOT_FOUND"
    | "AI_OUTPUT_INVALID"
    | "MODEL_UNAVAILABLE"
    | "KNOWLEDGE_UNAVAILABLE"
    | "PERSISTENCE_ERROR"
    | "TURN_NOT_FOUND"
    | "CONVERSATION_BUSY"
    | "IDEMPOTENCY_KEY_REUSED"
    | "TURN_RETRY_REQUIRED"
    | "TURN_NOT_RETRYABLE"
    | "INTERRUPTED_BY_RESTART"
    | "INTERNAL_ERROR",
  message: string,
  retryable: boolean,
): ApiException {
  return new ApiException(
    status,
    ApiErrorSchema.parse({
      contract_version: "1.0.0",
      error: {
        code,
        message,
        retryable,
        request_id: randomUUID(),
      },
    }),
  );
}

export function invalidRequest(message = "请求不符合本地 MVP 接口要求。"): ApiException {
  return apiError(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", message, false);
}

export function conversationNotFound(): ApiException {
  return apiError(HttpStatus.NOT_FOUND, "CONVERSATION_NOT_FOUND", "未找到指定会话。", false);
}

export function turnNotFound(): ApiException {
  return apiError(HttpStatus.NOT_FOUND, "TURN_NOT_FOUND", "未找到指定 turn。", false);
}

export function conversationBusy(): ApiException {
  return apiError(HttpStatus.CONFLICT, "CONVERSATION_BUSY", "当前会话已有消息正在处理中。", true);
}

export function idempotencyKeyReused(): ApiException {
  return apiError(HttpStatus.CONFLICT, "IDEMPOTENCY_KEY_REUSED", "消息标识已被不同内容使用。", false);
}

export function turnRetryRequired(): ApiException {
  return apiError(HttpStatus.CONFLICT, "TURN_RETRY_REQUIRED", "失败 turn 必须通过 retry 接口重试。", true);
}

export function turnNotRetryable(): ApiException {
  return apiError(HttpStatus.CONFLICT, "TURN_NOT_RETRYABLE", "该 turn 当前不可重试。", false);
}

export function invalidAiOutput(message = "上游输出不符合契约要求。"): ApiException {
  return apiError(HttpStatus.UNPROCESSABLE_ENTITY, "AI_OUTPUT_INVALID", message, true);
}

export function asApiException(error: unknown): ApiException {
  if (error instanceof ApiException) {
    return error;
  }
  if (error instanceof ModelUnavailableError) {
    return apiError(HttpStatus.SERVICE_UNAVAILABLE, "MODEL_UNAVAILABLE", "模型服务暂不可用，请稍后重试。", true);
  }
  if (error instanceof KnowledgeUnavailableError) {
    return apiError(HttpStatus.SERVICE_UNAVAILABLE, "KNOWLEDGE_UNAVAILABLE", "知识服务暂不可用，请稍后重试。", true);
  }
  if (error instanceof PersistenceError) {
    return apiError(HttpStatus.INTERNAL_SERVER_ERROR, "PERSISTENCE_ERROR", "会话结果暂未保存，请稍后重试。", true);
  }
  if (error instanceof SyntaxError) {
    return invalidRequest("请求 JSON 格式无效。");
  }
  if (error instanceof HttpException) {
    return error.getStatus() === HttpStatus.NOT_FOUND
      ? apiError(HttpStatus.NOT_FOUND, "INVALID_REQUEST", "请求路径不存在。", false)
      : invalidRequest();
  }
  if (error instanceof Error && error.name === "ZodError") {
    return invalidAiOutput();
  }
  return apiError(HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", "本地服务发生未分类错误。", false);
}
