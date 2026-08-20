import { memo } from "react";
import type { Theme } from "../../hooks/use-theme";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "../ai-elements/message";
import { XCircle } from "lucide-react";
import { hasRawToolCallMarker, splitRawToolCallSegments, RawToolCallBlock } from "./RawToolCallBlock";

export interface ChatMessageProps {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly timestamp: number;
  readonly theme: Theme;
  /** 工作台窄列使用更紧凑的字号，其它会话保持原样。 */
  readonly compact?: boolean;
}

export const ChatMessage = memo(function ChatMessage({
  role,
  content,
  compact = false,
}: ChatMessageProps) {
  const isUser = role === "user";
  const isError = content.startsWith("\u2717");
  const textClass = compact ? "text-[13.5px] leading-6" : "text-[17px] leading-[1.72]";

  return (
    <Message from={role}>
      <MessageContent>
        {isUser ? (
          <div className={textClass}>{content}</div>
        ) : isError ? (
          <div className={`flex items-center gap-2 text-destructive ${textClass}`}>
            <XCircle size={14} className="shrink-0" />
            <span>{content.replace(/^\u2717\s*/, "")}</span>
          </div>
        ) : hasRawToolCallMarker(content) ? (
          /* 模型把工具调用以文本标记吐进正文时：解析成 Tool Card，禁止裸 JSON 直出 */
          <>
            {splitRawToolCallSegments(content).map((segment, i) =>
              segment.type === "text"
                ? segment.text.trim() && <MessageResponse key={i}>{segment.text}</MessageResponse>
                : <RawToolCallBlock key={i} segment={segment} />,
            )}
          </>
        ) : (
          <MessageResponse>{content}</MessageResponse>
        )}
      </MessageContent>
    </Message>
  );
});

ChatMessage.displayName = "ChatMessage";
