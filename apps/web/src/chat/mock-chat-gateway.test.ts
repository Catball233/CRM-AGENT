import { describe, expect, it } from "vitest";
import { MockChatGateway } from "./mock-chat-gateway";

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
