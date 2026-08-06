import { randomUUID } from "node:crypto";
import { HttpStatus } from "@nestjs/common";
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

export function apiError(
  status: number,
  code: "INVALID_REQUEST" | "CONVERSATION_NOT_FOUND" | "AI_OUTPUT_INVALID" | "MODEL_UNAVAILABLE" | "INTERNAL_ERROR",
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

export function asApiException(error: unknown): ApiException {
  if (error instanceof ApiException) {
    return error;
  }
  if (error instanceof ModelUnavailableError) {
    return apiError(HttpStatus.SERVICE_UNAVAILABLE, "MODEL_UNAVAILABLE", "模型服务暂不可用，请稍后重试。", true);
  }
  if (error instanceof Error && error.name === "ZodError") {
    return apiError(HttpStatus.UNPROCESSABLE_ENTITY, "AI_OUTPUT_INVALID", "上游输出不符合契约要求。", true);
  }
  return apiError(HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", "本地服务发生未分类错误。", false);
}
