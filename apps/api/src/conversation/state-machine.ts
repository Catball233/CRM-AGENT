import type { ConversationStage } from "@crm-agent/contracts";
import { invalidRequest } from "./errors";

const ALLOWED_TRANSITIONS: Readonly<Record<ConversationStage, readonly ConversationStage[]>> = {
  DISCOVERY: ["DISCOVERY", "QUALIFYING", "CLOSED"],
  QUALIFYING: ["QUALIFYING", "QUOTING", "CLOSED"],
  QUOTING: ["NEGOTIATION", "COMPLETED", "QUALIFYING", "CLOSED"],
  NEGOTIATION: ["NEGOTIATION", "QUOTING", "COMPLETED", "CLOSED"],
  COMPLETED: ["DISCOVERY", "NEGOTIATION", "CLOSED"],
  CLOSED: [],
};

export function transitionStage(
  current: ConversationStage,
  requested: ConversationStage,
): ConversationStage {
  if (!ALLOWED_TRANSITIONS[current].includes(requested)) {
    throw invalidRequest("会话当前状态不允许本次迁移。");
  }
  return requested;
}
