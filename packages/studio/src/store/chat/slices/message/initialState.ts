import type { MessageState } from "../../types";

function restore(key: string): string | null {
  try {
    return typeof window !== "undefined" ? window.localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

const storedThinking = restore("inkos:chat:thinking-level");
const storedMode = restore("inkos:chat:interaction-mode");

export const initialMessageState: MessageState = {
  sessions: {},
  sessionIdsByBook: {},
  activeSessionId: null,
  input: "",
  selectedModel: null,
  selectedService: null,
  thinkingLevel: ["minimal", "low", "medium", "high", "xhigh"].includes(storedThinking ?? "")
    ? storedThinking
    : null,
  interactionMode: storedMode === "ask" ? "ask" : "agent",
};
