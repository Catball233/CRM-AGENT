import { z } from "zod";

const STORAGE_KEY = "crm-agent.d02.session-index.v1";

const RecentConversationSchema = z
  .object({
    conversationId: z.string().uuid(),
    title: z.string().min(1).max(40),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

const SessionIndexSchema = z
  .object({
    activeConversationId: z.string().uuid().nullable(),
    conversations: z.array(RecentConversationSchema).max(20),
  })
  .strict();

export type RecentConversation = z.output<typeof RecentConversationSchema>;
export type SessionIndex = z.output<typeof SessionIndexSchema>;

export const EMPTY_SESSION_INDEX: SessionIndex = {
  activeConversationId: null,
  conversations: [],
};

export function loadSessionIndex(storage: Storage): SessionIndex {
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return EMPTY_SESSION_INDEX;

  try {
    return SessionIndexSchema.parse(JSON.parse(raw));
  } catch {
    return EMPTY_SESSION_INDEX;
  }
}

export function saveSessionIndex(storage: Storage, value: SessionIndex) {
  storage.setItem(STORAGE_KEY, JSON.stringify(SessionIndexSchema.parse(value)));
}

export function upsertRecentConversation(
  index: SessionIndex,
  conversation: RecentConversation,
): SessionIndex {
  const conversations = [
    conversation,
    ...index.conversations.filter(
      (item) => item.conversationId !== conversation.conversationId,
    ),
  ].slice(0, 20);

  return {
    activeConversationId: conversation.conversationId,
    conversations,
  };
}

export function removeRecentConversation(
  index: SessionIndex,
  conversationId: string,
): SessionIndex {
  const conversations = index.conversations.filter(
    (item) => item.conversationId !== conversationId,
  );
  return {
    activeConversationId:
      index.activeConversationId === conversationId
        ? null
        : index.activeConversationId,
    conversations,
  };
}
