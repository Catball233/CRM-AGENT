import { describe, expect, it } from "vitest";
import { MockChatGateway } from "./mock-chat-gateway";
import type { ChatTurnResult } from "@crm-agent/contracts";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe("MockChatGateway conversation generations", () => {
  it("does not recreate a conversation deleted while its stream is in flight", async () => {
    const storage = new MemoryStorage();
    const gateway = new MockChatGateway(storage, { delayMs: 1 });
    const conversation = await gateway.createConversation();
    const stream = gateway.sendMessage(conversation.conversation_id, {
      contract_version: "1.0.0",
      client_message_id: "10000000-0000-4000-8000-000000000001",
      content: "测试删除在途会话",
      response_mode: "stream",
    })[Symbol.asyncIterator]();

    expect((await stream.next()).value?.event_type).toBe("turn.accepted");
    await gateway.deleteConversation(conversation.conversation_id);
    for (let next = await stream.next(); !next.done; next = await stream.next()) {
      // Consume the remaining events to exercise the terminal persistence path.
    }

    await expect(gateway.getConversation(conversation.conversation_id)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(JSON.parse(storage.getItem("crm-agent.d02.mock-gateway.v1") ?? "{}"))
      .toEqual({ conversations: {} });
  });
});

describe("MockChatGateway quote version continuity", () => {
  it("derives the next quote version from the persisted snapshot across re-instantiation", async () => {
    const storage = new MemoryStorage();
    const first = new MockChatGateway(storage, { delayMs: 0 });
    const conversation = await first.createConversation();
    const v1 = await consumeResult(first, conversation.conversation_id, "10000000-0000-4000-8000-000000000001", "生成测试报价");
    expect(v1.quote).not.toBeNull();
    expect(v1.quote!.quote_version).toBe(1);
    expect(v1.quote!.parent_quote_id).toBeNull();
    const v1Id = v1.quote!.quote_id;
    const refreshed = new MockChatGateway(storage, { delayMs: 0 });
    const v2 = await consumeResult(refreshed, conversation.conversation_id, "10000000-0000-4000-8000-000000000002", "调整测试报价");
    expect(v2.quote).not.toBeNull();
    expect(v2.quote!.quote_version).toBe(2);
    expect(v2.quote!.parent_quote_id).toBe(v1Id);
  });
  it("produces an unavailable turn (quote null, no_active_rule) for the trigger phrase", async () => {
    const storage = new MemoryStorage();
    const gateway = new MockChatGateway(storage, { delayMs: 0 });
    const conversation = await gateway.createConversation();
    const result = await consumeResult(gateway, conversation.conversation_id, "10000000-0000-4000-8000-000000000003", "触发不可报价");
    expect(result.quote).toBeNull();
    expect(result.warnings).toContain("no_active_rule");
  });
});
async function consumeResult(gateway: MockChatGateway, conversationId: string, clientMessageId: string, content: string): Promise<ChatTurnResult> {
  let result: ChatTurnResult | null = null;
  for await (const event of gateway.sendMessage(conversationId, {
    contract_version: "1.0.0",
    client_message_id: clientMessageId,
    content,
    response_mode: "stream",
  })) {
    if (event.event_type === "turn.completed") result = event.payload.result;
  }
  if (!result) throw new Error("turn.completed never emitted");
  return result;
}
