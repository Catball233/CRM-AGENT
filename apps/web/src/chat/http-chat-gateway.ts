import {
  ApiErrorSchema,
  ChatEventSchema,
  ConversationSnapshotSchema,
  ConversationViewSchema,
  type ChatEvent,
} from "@crm-agent/contracts";
import {
  ChatGatewayError,
  type ChatGateway,
  type ConversationSnapshot,
  type SendMessageRequest,
} from "./chat-gateway";

const DEFAULT_BASE_PATH = "/api/v1";

export class HttpChatGateway implements ChatGateway {
  constructor(
    private readonly basePath = DEFAULT_BASE_PATH,
    private readonly request: typeof fetch = globalThis.fetch,
  ) {}

  async createConversation() {
    const response = await this.fetchJson(`${this.basePath}/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contract_version: "1.0.0" }),
    });
    return ConversationViewSchema.parse(response);
  }

  async getConversation(conversationId: string): Promise<ConversationSnapshot> {
    const response = await this.fetchJson(`${this.basePath}/conversations/${encodeURIComponent(conversationId)}`);
    return ConversationSnapshotSchema.parse(response);
  }

  async deleteConversation(conversationId: string): Promise<void> {
    const response = await this.request.call(globalThis, `${this.basePath}/conversations/${encodeURIComponent(conversationId)}`, {
      method: "DELETE",
    });
    if (!response.ok) await this.throwApiError(response);
  }

  async *sendMessage(conversationId: string, request: SendMessageRequest): AsyncIterable<ChatEvent> {
    const response = await this.request.call(globalThis, `${this.basePath}/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": request.client_message_id,
      },
      body: JSON.stringify(request),
    });
    if (!response.ok) await this.throwApiError(response);
    if (!response.body) {
      throw new ChatGatewayError("network", "本地聊天服务未返回可读取的事件流。");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const parsed = consumeEvents(buffer);
        buffer = parsed.remainder;
        for (const event of parsed.events) yield event;
      }
      buffer += decoder.decode();
      const parsed = consumeEvents(buffer, true);
      for (const event of parsed.events) yield event;
      if (parsed.remainder.trim()) {
        throw new ChatGatewayError("contract", "本地聊天服务返回了不完整的事件流。");
      }
    } catch (error) {
      if (error instanceof ChatGatewayError) throw error;
      throw new ChatGatewayError("network", "本地聊天服务连接中断，请重试。");
    } finally {
      reader.releaseLock();
    }
  }

  private async fetchJson(path: string, init?: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      // Browser-native fetch requires Window/globalThis as its receiver.  Calling
      // the stored function as `this.request(...)` binds it to this gateway
      // instance and can throw synchronously before any request is sent.
      response = await this.request.call(globalThis, path, init);
    } catch {
      throw new ChatGatewayError("network", "无法连接本地聊天服务，请确认 API 已启动。");
    }
    if (!response.ok) await this.throwApiError(response);
    try {
      return await response.json();
    } catch {
      throw new ChatGatewayError("contract", "本地聊天服务返回了无效响应。");
    }
  }

  private async throwApiError(response: Response): Promise<never> {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ChatGatewayError("network", "本地聊天服务返回了无效错误响应。");
    }
    const parsed = ApiErrorSchema.safeParse(body);
    if (parsed.success) {
      throw new ChatGatewayError(
        response.status === 404 ? "not_found" : "unknown",
        parsed.data.error.message,
      );
    }
    throw new ChatGatewayError("contract", "本地聊天服务返回了未识别的错误响应。");
  }
}

function consumeEvents(input: string, ended = false) {
  const blocks = input.split(/\r?\n\r?\n/);
  const remainder = ended ? "" : blocks.pop() ?? "";
  const events: ChatEvent[] = [];
  for (const block of blocks) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      events.push(ChatEventSchema.parse(JSON.parse(data)));
    } catch {
      throw new ChatGatewayError("contract", "本地聊天服务返回了不符合契约的事件。");
    }
  }
  return { events, remainder };
}
