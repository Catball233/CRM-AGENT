"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import {
  assertTerminalStream,
  createChatStreamState,
  reduceChatEvent,
  type AnalysisSummary,
} from "../chat/chat-event-reducer";
import { getBrowserStorage } from "../chat/browser-storage";
import {
  ChatGatewayError,
  getSafeErrorMessage,
  type ChatGateway,
  type ConversationSnapshot,
} from "../chat/chat-gateway";
import { MockChatGateway } from "../chat/mock-chat-gateway";
import {
  EMPTY_SESSION_INDEX,
  loadSessionIndex,
  removeRecentConversation,
  saveSessionIndex,
  upsertRecentConversation,
  type SessionIndex,
} from "../chat/session-index";

const SUGGESTED_PROMPTS = [
  "我家 90㎡旧房，想做全屋中档装修",
  "预算 20 万，应该先确认哪些信息？",
  "环保材料和施工工期需要注意什么？",
] as const;

const INTENT_LABELS: Record<string, string> = {
  greeting: "问候",
  consulting: "装修咨询",
  quote_request: "报价意向",
  provide_information: "补充信息",
  negotiation: "价格协商",
  plan_adjustment: "方案调整",
  rejection: "拒绝继续",
  unrelated: "无关内容",
  risk: "安全风险",
  unclear: "意图不明",
};

const VALUE_LABELS: Record<string, string> = {
  high: "高",
  medium: "中",
  low: "低",
  unknown: "未知",
};

const ACTION_LABELS: Record<string, string> = {
  answer_question: "回答问题",
  ask_missing_fields: "继续确认信息",
  search_knowledge: "检索知识",
  prepare_quote: "准备报价",
  adjust_quote: "调整方案",
  clarify_conflict: "澄清冲突",
  stop_sales_guidance: "停止销售引导",
  safe_stop: "安全停止",
};

const STAGE_LABELS: Record<string, string> = {
  DISCOVERY: "需求发现",
  QUALIFYING: "信息确认",
  QUOTING: "报价准备",
  NEGOTIATION: "方案协商",
  COMPLETED: "已完成",
  CLOSED: "已关闭",
};

function createClientId() {
  return globalThis.crypto.randomUUID();
}

function createTitle(content: string) {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > 18 ? `${normalized.slice(0, 18)}…` : normalized;
}

interface ChatWorkspaceProps {
  gateway?: ChatGateway;
}

export function ChatWorkspace({ gateway: providedGateway }: ChatWorkspaceProps) {
  const [gateway, setGateway] = useState<ChatGateway | null>(providedGateway ?? null);
  const [storage, setStorage] = useState<Storage | null>(null);
  const [sessionIndex, setSessionIndex] = useState<SessionIndex>(EMPTY_SESSION_INDEX);
  const [snapshot, setSnapshot] = useState<ConversationSnapshot | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisSummary | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingContent, setPendingContent] = useState<string | null>(null);
  const [streamedText, setStreamedText] = useState("");
  const [status, setStatus] = useState<"booting" | "ready" | "loading" | "sending">(
    "booting",
  );
  const [error, setError] = useState<string | null>(null);
  const [analysisOpen, setAnalysisOpen] = useState(true);
  const [sessionPanelOpen, setSessionPanelOpen] = useState(false);
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const messageEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const browserStorage = getBrowserStorage();
    setStorage(browserStorage);
    if (!providedGateway) {
      setGateway(new MockChatGateway(browserStorage));
    }
  }, [providedGateway]);

  const persistIndex = useCallback((next: SessionIndex) => {
    if (!storage) return;
    saveSessionIndex(storage, next);
    setSessionIndex(next);
  }, [storage]);

  const restoreConversation = useCallback(
    async (conversationId: string, targetGateway = gateway) => {
      if (!targetGateway || !storage) return;
      setStatus("loading");
      setError(null);
      setAnalysis(null);
      try {
        const nextSnapshot = await targetGateway.getConversation(conversationId);
        setSnapshot(nextSnapshot);
        const index = loadSessionIndex(storage);
        persistIndex({ ...index, activeConversationId: conversationId });
      } catch (restoreError) {
        setSnapshot(null);
        setError(getSafeErrorMessage(restoreError));
      } finally {
        setStatus("ready");
      }
    },
    [gateway, persistIndex, storage],
  );

  useEffect(() => {
    if (!gateway || !storage) return;
    const index = loadSessionIndex(storage);
    setSessionIndex(index);
    if (index.activeConversationId) {
      void restoreConversation(index.activeConversationId, gateway);
    } else {
      setStatus("ready");
    }
  }, [gateway, restoreConversation, storage]);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView?.({ behavior: "smooth", block: "end" });
  }, [snapshot?.messages.length, pendingContent, streamedText]);

  const createConversation = useCallback(async () => {
    if (!gateway || !storage || status === "sending") return;
    setStatus("loading");
    setError(null);
    setAnalysis(null);
    try {
      const conversation = await gateway.createConversation();
      const nextSnapshot = await gateway.getConversation(conversation.conversation_id);
      const nextIndex = upsertRecentConversation(loadSessionIndex(storage), {
        conversationId: conversation.conversation_id,
        title: "新建测试会话",
        updatedAt: conversation.updated_at,
      });
      persistIndex(nextIndex);
      setSnapshot(nextSnapshot);
      setSessionPanelOpen(false);
    } catch (createError) {
      setError(getSafeErrorMessage(createError));
    } finally {
      setStatus("ready");
    }
  }, [gateway, persistIndex, status, storage]);

  const sendMessage = useCallback(async () => {
    const content = draft.trim();
    if (!gateway || !snapshot || !storage || !content || status === "sending") return;

    setStatus("sending");
    setError(null);
    setDraft("");
    setPendingContent(content);
    setStreamedText("");
    const clientMessageId = createClientId();
    let streamState = createChatStreamState(snapshot.conversation.conversation_id);

    try {
      for await (const event of gateway.sendMessage(snapshot.conversation.conversation_id, {
        contract_version: "1.0.0",
        client_message_id: clientMessageId,
        content,
        response_mode: "stream",
      })) {
        streamState = reduceChatEvent(streamState, event);
        setStreamedText(streamState.streamedText);
        if (streamState.analysis) setAnalysis(streamState.analysis);
      }
      assertTerminalStream(streamState);
      if (streamState.terminal === "failed") {
        throw new ChatGatewayError(
          "unknown",
          streamState.error?.message ?? "本轮处理失败，请稍后重试。",
        );
      }

      const nextSnapshot = await gateway.getConversation(snapshot.conversation.conversation_id);
      setSnapshot(nextSnapshot);
      const currentIndex = loadSessionIndex(storage);
      const existing = currentIndex.conversations.find(
        (item) => item.conversationId === snapshot.conversation.conversation_id,
      );
      persistIndex(
        upsertRecentConversation(currentIndex, {
          conversationId: snapshot.conversation.conversation_id,
          title: existing?.title === "新建测试会话" || !existing ? createTitle(content) : existing.title,
          updatedAt: nextSnapshot.conversation.updated_at,
        }),
      );
    } catch (sendError) {
      setError(getSafeErrorMessage(sendError));
    } finally {
      setPendingContent(null);
      setStreamedText("");
      setStatus("ready");
    }
  }, [draft, gateway, persistIndex, snapshot, status, storage]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    void sendMessage();
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  };

  const clearConversation = useCallback(async () => {
    if (!gateway || !snapshot || !storage) return;
    const conversationId = snapshot.conversation.conversation_id;
    setClearDialogOpen(false);
    setStatus("loading");
    setError(null);
    try {
      await gateway.deleteConversation(conversationId);
      const nextIndex = removeRecentConversation(
        loadSessionIndex(storage),
        conversationId,
      );
      persistIndex(nextIndex);
      setAnalysis(null);
      if (nextIndex.activeConversationId) {
        await restoreConversation(nextIndex.activeConversationId, gateway);
      } else {
        setSnapshot(null);
      }
    } catch (clearError) {
      setError(getSafeErrorMessage(clearError));
    } finally {
      setStatus("ready");
    }
  }, [gateway, persistIndex, restoreConversation, snapshot, storage]);

  const isBusy = status === "booting" || status === "loading" || status === "sending";
  const sessionId = snapshot?.conversation.conversation_id;
  const shortSessionId = sessionId ? sessionId.slice(0, 8) : "未创建";
  const currentStage = snapshot ? STAGE_LABELS[snapshot.conversation.stage] : "等待会话";

  const visibleMessages = useMemo(() => snapshot?.messages ?? [], [snapshot]);

  return (
    <main className={`workspace ${analysisOpen ? "" : "analysis-collapsed"}`}>
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">AI</span>
          <div>
            <p className="eyebrow">LOCAL RENOVATION COPILOT</p>
            <h1>装修销售 AI 助手</h1>
          </div>
        </div>
        <div className="topbar-status">
          <span className="status-dot" aria-hidden="true" />
          模拟 API
          <span className="session-code">会话 {shortSessionId}</span>
        </div>
        <button
          className="mobile-panel-button"
          type="button"
          onClick={() => setSessionPanelOpen((open) => !open)}
          aria-expanded={sessionPanelOpen}
          aria-controls="session-panel"
        >
          会话
        </button>
      </header>

      <aside
        id="session-panel"
        className={`session-panel ${sessionPanelOpen ? "mobile-open" : ""}`}
        aria-label="测试会话"
      >
        <button className="primary-action" type="button" onClick={() => void createConversation()} disabled={isBusy}>
          <span aria-hidden="true">＋</span> 新建测试会话
        </button>
        <div className="panel-heading">
          <span>最近会话</span>
          <span>{sessionIndex.conversations.length}</span>
        </div>
        <div className="session-list">
          {sessionIndex.conversations.length === 0 ? (
            <p className="panel-empty">还没有本地测试会话</p>
          ) : (
            sessionIndex.conversations.map((conversation) => (
              <button
                key={conversation.conversationId}
                type="button"
                className={`session-item ${sessionId === conversation.conversationId ? "active" : ""}`}
                onClick={() => {
                  void restoreConversation(conversation.conversationId);
                  setSessionPanelOpen(false);
                }}
                disabled={isBusy}
              >
                <span className="session-icon" aria-hidden="true">◇</span>
                <span>
                  <strong>{conversation.title}</strong>
                  <small>{conversation.conversationId.slice(0, 8)}</small>
                </span>
              </button>
            ))
          )}
        </div>
        <div className="session-footer">
          <div>
            <span>当前阶段</span>
            <strong>{currentStage}</strong>
          </div>
          <button
            type="button"
            className="danger-action"
            disabled={!snapshot || isBusy}
            onClick={() => setClearDialogOpen(true)}
          >
            清空当前会话
          </button>
        </div>
      </aside>

      <section className="chat-panel" aria-label="聊天窗口">
        <div className="chat-heading">
          <div>
            <p className="eyebrow">CONVERSATION</p>
            <h2>{snapshot ? "本地需求沟通" : "开始一次测试对话"}</h2>
          </div>
          <span className="stage-chip">{currentStage}</span>
        </div>

        <div className="messages" aria-live="polite">
          {status === "booting" || status === "loading" ? (
            <div className="loading-state" role="status">
              <span className="loading-orbit" aria-hidden="true" />
              正在读取本地测试会话…
            </div>
          ) : !snapshot ? (
            <div className="welcome-state">
              <div className="welcome-orb" aria-hidden="true"><span>AI</span></div>
              <p className="eyebrow">D-02 LOCAL MVP</p>
              <h2>让装修需求，从一句话开始</h2>
              <p className="welcome-copy">
                当前页面使用模拟事件展示意图识别、价值判断、知识介入与上下文恢复，不会产生真实报价。
              </p>
              <div className="capability-row" aria-label="MVP 演示能力">
                {['意图识别', '价值判断', '知识介入', '上下文', '记忆演示'].map((item) => (
                  <span key={item}>{item}</span>
                ))}
              </div>
              <button className="primary-action welcome-action" type="button" onClick={() => void createConversation()}>
                创建测试会话
              </button>
            </div>
          ) : visibleMessages.length === 0 && !pendingContent ? (
            <div className="prompt-state">
              <div className="prompt-intro">
                <span className="assistant-avatar" aria-hidden="true">AI</span>
                <div>
                  <strong>你好，我是本地装修需求助手。</strong>
                  <p>可以从面积、预算、城市或材料偏好开始描述。</p>
                </div>
              </div>
              <div className="suggestions">
                {SUGGESTED_PROMPTS.map((prompt) => (
                  <button type="button" key={prompt} onClick={() => setDraft(prompt)}>
                    <span>{prompt}</span><span aria-hidden="true">↗</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {visibleMessages.map((message) => (
            <article key={message.message_id} className={`message ${message.role}`}>
              <span className="message-avatar" aria-hidden="true">{message.role === "user" ? "你" : "AI"}</span>
              <div className="message-body">
                <span className="message-author">{message.role === "user" ? "你" : "装修助手"}</span>
                <p>{message.content}</p>
              </div>
            </article>
          ))}
          {pendingContent ? (
            <>
              <article className="message user pending">
                <span className="message-avatar" aria-hidden="true">你</span>
                <div className="message-body"><span className="message-author">你</span><p>{pendingContent}</p></div>
              </article>
              <article className="message assistant pending">
                <span className="message-avatar" aria-hidden="true">AI</span>
                <div className="message-body">
                  <span className="message-author">装修助手 · 正在分析</span>
                  <p>{streamedText || <span className="typing-dots" aria-label="正在生成"><i /><i /><i /></span>}</p>
                </div>
              </article>
            </>
          ) : null}
          <div ref={messageEndRef} />
        </div>

        {error ? <div className="error-banner" role="alert"><span aria-hidden="true">!</span>{error}</div> : null}

        <form className="composer" onSubmit={handleSubmit}>
          <textarea
            aria-label="输入装修需求"
            placeholder={snapshot ? "输入装修需求，Enter 发送，Shift + Enter 换行" : "请先创建测试会话"}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            disabled={!snapshot || isBusy}
            maxLength={8000}
            rows={2}
          />
          <button
            type="submit"
            className="send-button"
            disabled={!snapshot || isBusy || draft.trim().length === 0}
            aria-label="发送消息"
          >
            <span aria-hidden="true">↑</span>
          </button>
          <div className="composer-meta">
            <span>仅使用虚构或脱敏测试信息</span>
            <span>{draft.length}/8000</span>
          </div>
        </form>
      </section>

      <aside className="analysis-panel" aria-label="模拟分析摘要">
        <div className="analysis-heading">
          <div><p className="eyebrow">LIVE INSIGHTS</p><h2>模拟分析</h2></div>
          <button type="button" onClick={() => setAnalysisOpen((open) => !open)} aria-expanded={analysisOpen} aria-label={analysisOpen ? "收起分析栏" : "展开分析栏"}>
            {analysisOpen ? "→" : "←"}
          </button>
        </div>
        <div className="analysis-content">
          <div className="simulation-notice"><span aria-hidden="true">◎</span>本面板仅展示模拟事件，不代表真实客户结论</div>
          <div className="insight-card accent">
            <span>识别意图</span>
            <strong>{analysis ? (INTENT_LABELS[analysis.intent] ?? analysis.intent) : "等待新消息"}</strong>
            <small>{analysis ? "来自 analysis.completed" : "发送消息后生成"}</small>
          </div>
          <div className="insight-grid">
            <div className="insight-card"><span>价值等级</span><strong>{analysis ? (VALUE_LABELS[analysis.value_level] ?? analysis.value_level) : "—"}</strong></div>
            <div className="insight-card"><span>当前阶段</span><strong>{currentStage}</strong></div>
          </div>
          <div className="insight-card"><span>建议动作</span><strong>{analysis ? (ACTION_LABELS[analysis.next_action] ?? analysis.next_action) : "等待分析"}</strong></div>
          <div className="flow-card">
            <p className="panel-heading"><span>本轮事件</span><span>{status === "sending" ? "LIVE" : "READY"}</span></p>
            {['接收消息', '分析意图', '生成回复', '完成本轮'].map((item, index) => (
              <div className={`flow-step ${status === "sending" && index < 3 ? "active" : ""}`} key={item}>
                <span>{index + 1}</span><strong>{item}</strong>
              </div>
            ))}
          </div>
        </div>
      </aside>

      {!analysisOpen ? (
        <button className="analysis-restore" type="button" onClick={() => setAnalysisOpen(true)}>
          展开分析
        </button>
      ) : null}

      {clearDialogOpen ? (
        <div className="dialog-backdrop" role="presentation">
          <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="clear-dialog-title">
            <span className="dialog-icon" aria-hidden="true">!</span>
            <h2 id="clear-dialog-title">清空当前测试会话？</h2>
            <p>这会删除该会话在浏览器中的模拟消息，操作无法撤销。</p>
            <div className="dialog-actions">
              <button type="button" onClick={() => setClearDialogOpen(false)}>取消</button>
              <button type="button" className="danger-confirm" onClick={() => void clearConversation()}>确认清空</button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
