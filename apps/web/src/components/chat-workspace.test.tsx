/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChatEvent } from "@crm-agent/contracts";
import { failedEventStream, networkFailureState } from "@crm-agent/test-fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ChatGateway,
  ConversationSnapshot,
  SendMessageRequest,
} from "../chat/chat-gateway";
import { ChatGatewayError } from "../chat/chat-gateway";
import { MockChatGateway } from "../chat/mock-chat-gateway";
import { saveSessionIndex } from "../chat/session-index";
import { ChatWorkspace } from "./chat-workspace";

afterEach(() => cleanup());

beforeEach(() => {
  window.localStorage.clear();
});

function createGateway() {
  return new MockChatGateway(window.localStorage, { delayMs: 0 });
}

async function createSession(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "创建测试会话" }));
  await screen.findByText("你好，我是本地装修需求助手。");
}

describe("D-02 chat workspace", () => {
  it("rejects a synchronous duplicate new-session action", async () => {
    class CountingCreateGateway extends MockChatGateway {
      calls = 0;

      override async createConversation() {
        this.calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return super.createConversation();
      }
    }

    const gateway = new CountingCreateGateway(window.localStorage, { delayMs: 0 });
    render(<ChatWorkspace gateway={gateway} />);
    const createButton = await screen.findByRole("button", { name: "创建测试会话" });

    fireEvent.click(createButton);
    fireEvent.click(createButton);

    expect(await screen.findByText("你好，我是本地装修需求助手。")).toBeInTheDocument();
    expect(gateway.calls).toBe(1);
  });

  it("creates a session, sends a turn and displays the analysis summary", async () => {
    const user = userEvent.setup();
    render(<ChatWorkspace gateway={createGateway()} />);
    await createSession(user);

    await user.click(screen.getByRole("button", { name: /我家 90㎡旧房/ }));
    await user.click(screen.getByRole("button", { name: "发送消息" }));

    expect(await screen.findByText("已记录这次测试需求。为了继续评估，请先确认项目所在城市。")).toBeInTheDocument();
    expect(screen.getByText("报价意向")).toBeInTheDocument();
    expect(screen.getByText("继续确认信息")).toBeInTheDocument();
    expect(screen.getByText("中")).toBeInTheDocument();
  });

  it("restores the active conversation after remounting", async () => {
    const user = userEvent.setup();
    const firstRender = render(<ChatWorkspace gateway={createGateway()} />);
    await createSession(user);
    await user.type(screen.getByLabelText("输入装修需求"), "想了解环保材料和工期");
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    await screen.findByText(/当前为模拟知识介入演示/);
    firstRender.unmount();

    render(<ChatWorkspace gateway={createGateway()} />);

    expect(await screen.findByText("想了解环保材料和工期")).toBeInTheDocument();
    expect(screen.getByText(/当前为模拟知识介入演示/)).toBeInTheDocument();
    expect(screen.getByText("等待新消息")).toBeInTheDocument();
  });

  it("keeps the latest conversation selected when restores finish out of order", async () => {
    class DelayedRestoreGateway extends MockChatGateway {
      readonly delays = new Map<string, number>();

      override async getConversation(id: string): Promise<ConversationSnapshot> {
        const delay = this.delays.get(id) ?? 0;
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        return super.getConversation(id);
      }
    }

    const gateway = new DelayedRestoreGateway(window.localStorage, { delayMs: 0 });
    const first = await gateway.createConversation();
    const second = await gateway.createConversation();
    saveSessionIndex(window.localStorage, {
      activeConversationId: second.conversation_id,
      conversations: [
        {
          conversationId: second.conversation_id,
          title: "第二个测试会话",
          updatedAt: second.updated_at,
        },
        {
          conversationId: first.conversation_id,
          title: "第一个测试会话",
          updatedAt: first.updated_at,
        },
      ],
    });
    render(<ChatWorkspace gateway={gateway} />);
    const firstButton = await screen.findByRole("button", { name: /第一个测试会话/ });
    const secondButton = screen.getByRole("button", { name: /第二个测试会话/ });
    await waitFor(() => expect(secondButton).toHaveClass("active"));
    gateway.delays.set(first.conversation_id, 40);

    fireEvent.click(firstButton);
    fireEvent.click(secondButton);

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(secondButton).toHaveClass("active");
    expect(firstButton).not.toHaveClass("active");
  });

  it("requires confirmation before clearing a local test session", async () => {
    const user = userEvent.setup();
    render(<ChatWorkspace gateway={createGateway()} />);
    await createSession(user);

    await user.click(screen.getByRole("button", { name: "清空当前会话" }));
    expect(screen.getByRole("dialog", { name: "清空当前测试会话？" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认清空" }));

    expect(await screen.findByText("让装修需求，从一句话开始")).toBeInTheDocument();
    expect(screen.getByText("还没有本地测试会话")).toBeInTheDocument();
  });

  it("rejects a send attempt while clear confirmation is open and never restores the session", async () => {
    class CountingGateway extends MockChatGateway {
      sendCalls = 0;

      override async *sendMessage(
        id: string,
        request: SendMessageRequest,
      ): AsyncIterable<ChatEvent> {
        this.sendCalls += 1;
        for await (const event of super.sendMessage(id, request)) yield event;
      }
    }

    const gateway = new CountingGateway(window.localStorage, { delayMs: 5 });
    const user = userEvent.setup();
    render(<ChatWorkspace gateway={gateway} />);
    await createSession(user);
    await user.type(screen.getByLabelText("输入装修需求"), "清空竞态回归测试");
    const form = screen.getByRole("button", { name: "发送消息" }).closest("form");

    await user.click(screen.getByRole("button", { name: "清空当前会话" }));
    expect(screen.getByRole("dialog", { name: "清空当前测试会话？" })).toBeInTheDocument();
    expect(screen.getByLabelText("输入装修需求")).toBeDisabled();
    expect(form).not.toBeNull();
    fireEvent.submit(form!);
    expect(gateway.sendCalls).toBe(0);
    await user.click(screen.getByRole("button", { name: "确认清空" }));

    expect(await screen.findByText("让装修需求，从一句话开始")).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText("清空竞态回归测试")).not.toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem("crm-agent.d02.mock-gateway.v1") ?? "{}"))
      .toEqual({ conversations: {} });
  });

  it("returns to the empty state after clearing while retaining other recent sessions", async () => {
    const user = userEvent.setup();
    render(<ChatWorkspace gateway={createGateway()} />);
    await createSession(user);
    await user.type(screen.getByLabelText("输入装修需求"), "第一段测试会话");
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    await screen.findByText(/可以先说明房屋面积/);

    await user.click(screen.getByRole("button", { name: /新建测试会话/ }));
    await screen.findByText("你好，我是本地装修需求助手。");
    await user.click(screen.getByRole("button", { name: "清空当前会话" }));
    await user.click(screen.getByRole("button", { name: "确认清空" }));

    expect(await screen.findByText("让装修需求，从一句话开始")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /第一段测试会话/ })).toBeInTheDocument();
  });

  it("disables empty submission and supports Enter to send", async () => {
    const user = userEvent.setup();
    render(<ChatWorkspace gateway={createGateway()} />);
    await createSession(user);
    const composer = screen.getByLabelText("输入装修需求");
    const sendButton = screen.getByRole("button", { name: "发送消息" });

    expect(sendButton).toBeDisabled();
    await user.type(composer, "先介绍一下服务范围");
    fireEvent.keyDown(composer, { key: "Enter", code: "Enter", shiftKey: false });

    expect(await screen.findByText(/可以先说明房屋面积/)).toBeInTheDocument();
  });

  it("rejects a synchronous duplicate submission before React updates the disabled state", async () => {
    class CountingGateway extends MockChatGateway {
      calls = 0;

      override async *sendMessage(
        id: string,
        request: SendMessageRequest,
      ): AsyncIterable<ChatEvent> {
        this.calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        for await (const event of super.sendMessage(id, request)) yield event;
      }
    }

    const gateway = new CountingGateway(window.localStorage, { delayMs: 0 });
    const user = userEvent.setup();
    render(<ChatWorkspace gateway={gateway} />);
    await createSession(user);
    await user.type(screen.getByLabelText("输入装修需求"), "同步双提交测试");
    const form = screen.getByRole("button", { name: "发送消息" }).closest("form");

    expect(form).not.toBeNull();
    fireEvent.submit(form!);
    fireEvent.submit(form!);

    expect(await screen.findByText(/可以先说明房屋面积/)).toBeInTheDocument();
    expect(gateway.calls).toBe(1);
  });

  it("blocks obvious sensitive input before it reaches browser persistence", async () => {
    const user = userEvent.setup();
    render(<ChatWorkspace gateway={createGateway()} />);
    await createSession(user);
    const sensitiveInput = "请保存测试手机号 13800138000 并联系我";

    await user.type(screen.getByLabelText("输入装修需求"), sensitiveInput);
    await user.click(screen.getByRole("button", { name: "发送消息" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "请勿输入真实手机号、身份证号、邮箱、密钥或其他敏感信息",
    );
    expect(window.localStorage.getItem("crm-agent.d02.mock-gateway.v1")).not.toContain(
      "13800138000",
    );
  });

  it("shows a safe error when an event cannot pass the public schema", async () => {
    class InvalidEventGateway implements ChatGateway {
      private readonly delegate = createGateway();
      createConversation() { return this.delegate.createConversation(); }
      getConversation(id: string): Promise<ConversationSnapshot> { return this.delegate.getConversation(id); }
      deleteConversation(id: string) { return this.delegate.deleteConversation(id); }
      async *sendMessage(_id: string, _request: SendMessageRequest): AsyncIterable<ChatEvent> {
        yield { event_type: "analysis.completed" } as ChatEvent;
      }
    }

    const user = userEvent.setup();
    render(<ChatWorkspace gateway={new InvalidEventGateway()} />);
    await createSession(user);
    await user.type(screen.getByLabelText("输入装修需求"), "测试非法事件");
    await user.click(screen.getByRole("button", { name: "发送消息" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("模拟事件契约无效：事件结构无法解析"),
    );
  });

  it("shows safe messages for network failures and turn.failed", async () => {
    class NetworkErrorGateway implements ChatGateway {
      private readonly delegate = createGateway();
      createConversation() { return this.delegate.createConversation(); }
      getConversation(id: string): Promise<ConversationSnapshot> { return this.delegate.getConversation(id); }
      deleteConversation(id: string) { return this.delegate.deleteConversation(id); }
      async *sendMessage(): AsyncIterable<ChatEvent> {
        throw new ChatGatewayError("network", networkFailureState.user_safe_message);
      }
    }

    const user = userEvent.setup();
    const firstRender = render(<ChatWorkspace gateway={new NetworkErrorGateway()} />);
    await createSession(user);
    await user.type(screen.getByLabelText("输入装修需求"), "测试网络错误");
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      networkFailureState.user_safe_message,
    );
    firstRender.unmount();
    window.localStorage.clear();

    class FailedTurnGateway implements ChatGateway {
      private readonly delegate = createGateway();
      createConversation() { return this.delegate.createConversation(); }
      getConversation(id: string): Promise<ConversationSnapshot> { return this.delegate.getConversation(id); }
      deleteConversation(id: string) { return this.delegate.deleteConversation(id); }
      async *sendMessage(
        id: string,
        request: SendMessageRequest,
      ): AsyncIterable<ChatEvent> {
        for (const event of failedEventStream) {
          yield event.event_type === "turn.accepted"
            ? {
                ...event,
                conversation_id: id,
                payload: {
                  ...event.payload,
                  client_message_id: request.client_message_id,
                },
              }
            : { ...event, conversation_id: id };
        }
      }
    }

    render(<ChatWorkspace gateway={new FailedTurnGateway()} />);
    await createSession(user);
    await user.type(screen.getByLabelText("输入装修需求"), "测试终止错误");
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("回复生成失败，请稍后重试。");
  });

  it("collapses and restores the analysis panel", async () => {
    const user = userEvent.setup();
    render(<ChatWorkspace gateway={createGateway()} />);

    await user.click(await screen.findByRole("button", { name: "收起分析栏" }));
    expect(screen.getByRole("button", { name: "展开分析" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "展开分析" }));
    expect(screen.getByRole("button", { name: "收起分析栏" })).toBeInTheDocument();
  });
});

describe("D-03 review regression fixes", () => {
  it("does not let a prior quote occlude the knowledge_insufficient status", async () => {
    const user = userEvent.setup();
    render(<ChatWorkspace gateway={createGateway()} />);
    await createSession(user);
    const input = screen.getByLabelText("输入装修需求");
    await user.type(input, "生成测试报价");
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    expect(await screen.findAllByText("¥115,200.00")).toHaveLength(2);
    await user.type(input, "环保材料");
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    expect(await screen.findByText("知识不足")).toBeInTheDocument();
    expect(screen.queryAllByText("¥115,200.00")).toHaveLength(0);
  });
  it("preserves newly typed draft when retrying a failed turn", async () => {
    class FailSendGateway implements ChatGateway {
      private readonly delegate = createGateway();
      createConversation() { return this.delegate.createConversation(); }
      getConversation(id: string): Promise<ConversationSnapshot> { return this.delegate.getConversation(id); }
      deleteConversation(id: string): Promise<void> { return this.delegate.deleteConversation(id); }
      async *sendMessage(_id: string, _request: SendMessageRequest): AsyncIterable<ChatEvent> {
        throw new ChatGatewayError("network", "暂时无法连接本地服务，请检查服务状态后重试。");
      }
    }
    const user = userEvent.setup();
    render(<ChatWorkspace gateway={new FailSendGateway()} />);
    await createSession(user);
    const input = screen.getByLabelText("输入装修需求");
    await user.type(input, "测试重试");
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    await screen.findByRole("alert");
    await user.type(input, "新内容");
    await user.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.getByLabelText("输入装修需求")).toHaveValue("新内容"));
  });
});
