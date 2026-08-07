import { cleanup, render, type RenderResult } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatWorkspace } from "../../components/chat-workspace";
import { getBrowserStorage } from "../../chat/browser-storage";
import { MockChatGateway } from "../../chat/mock-chat-gateway";
import type { ChatGateway } from "../../chat/chat-gateway";

export function resetMockStorage(): void {
  window.localStorage.clear();
}

export function createMockGateway(): ChatGateway {
  return new MockChatGateway(getBrowserStorage(), { delayMs: 0 });
}

export interface WorkspaceHarness {
  user: ReturnType<typeof userEvent.setup>;
  view: RenderResult;
  gateway: ChatGateway;
}

export async function bootWorkspace(gateway?: ChatGateway): Promise<WorkspaceHarness> {
  const user = userEvent.setup();
  const resolvedGateway = gateway ?? createMockGateway();
  const view = render(<ChatWorkspace gateway={resolvedGateway} />);
  return { user, view, gateway: resolvedGateway };
}

/**
 * Remounts ChatWorkspace with NO injected gateway so it creates its own
 * MockChatGateway from localStorage. Used by S12 to verify that a restart
 * restores the persisted conversation history and current quote.
 */
export async function remountWorkspace(): Promise<RenderResult> {
  return render(<ChatWorkspace />);
}

export async function startConversation(harness: WorkspaceHarness): Promise<void> {
  const createButton = await harness.view.findByRole("button", { name: "创建测试会话" });
  await harness.user.click(createButton);
  await harness.view.findByLabelText("输入装修需求");
}

export async function sendUserMessage(harness: WorkspaceHarness, text: string): Promise<void> {
  const composer = await harness.view.findByLabelText("输入装修需求");
  await harness.user.clear(composer);
  await harness.user.type(composer, text);
  const sendButton = await harness.view.findByRole("button", { name: "发送消息" });
  await harness.user.click(sendButton);
}

/** Concatenated snapshot of all localStorage values, for PII-leak assertions. */
export function storageSnapshot(): string {
  let acc = "";
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i);
    if (key) acc += window.localStorage.getItem(key) ?? "";
  }
  return acc;
}

export { cleanup };