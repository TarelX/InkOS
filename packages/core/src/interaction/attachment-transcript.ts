/**
 * 会话记录与附件正文分离（V1 patch-attachment-transcript-separation 移植）：
 * 展开的附件内容只作当轮模型输入；会话记录/UI 只保存用户原文 + 精简文件引用。
 * 恢复会话时，模型上下文（且仅模型上下文）会拿到持久文件路径以便按需重读。
 */

const REF_KEYS = ["id", "filename", "mimeType", "size", "storedPath", "extractedPath"] as const;

export interface AttachmentRef {
  id?: string;
  filename: string;
  mimeType?: string;
  size?: number;
  storedPath?: string;
  extractedPath?: string;
}

export function compactAttachmentRefs(attachments: unknown): AttachmentRef[] {
  if (!Array.isArray(attachments)) return [];
  return attachments
    .filter((attachment): attachment is Record<string, unknown> => Boolean(attachment) && typeof attachment === "object")
    .map((attachment) => {
      const ref: Record<string, unknown> = {};
      for (const key of REF_KEYS) {
        const value = attachment[key];
        if (value !== undefined && value !== null && value !== "") ref[key] = value;
      }
      return ref as unknown as AttachmentRef;
    })
    .filter((ref) => typeof ref.filename === "string" && ref.filename.trim().length > 0);
}

export function buildAttachmentDisplayMessage(
  userMessage: string,
  attachments: unknown,
  language: string = "zh",
): string {
  const text = String(userMessage ?? "");
  const refs = compactAttachmentRefs(attachments);
  if (refs.length === 0) return text;
  const names = refs.map((ref) => ref.filename).join("、");
  const summary = language === "en"
    ? `Attachments (${refs.length}): ${names}`
    : `附件（${refs.length}）：${names}`;
  return text.trim() ? `${text}\n\n${summary}` : summary;
}

export function persistUserMessageWithAttachments<T extends { role?: unknown }>(
  message: T,
  displayMessage: string,
  attachments: unknown,
): T {
  const refs = compactAttachmentRefs(attachments);
  if (!message || typeof message !== "object" || refs.length === 0) return message;
  return {
    ...message,
    role: "user",
    content: [{ type: "text", text: String(displayMessage ?? "") }],
    inkosAttachments: refs,
  } as T;
}

export function restoredAttachmentReferenceBlock(
  message: { inkosAttachments?: unknown } | null | undefined,
  language: string = "zh",
): string {
  const refs = compactAttachmentRefs(message?.inkosAttachments);
  if (refs.length === 0) return "";
  const lines = [
    language === "en"
      ? "\n\n## Hidden attachment references (model context only)"
      : "\n\n## 隐藏附件引用（仅供模型恢复上下文）",
    language === "en"
      ? "The files remain on the host. Use the relevant material/read tool before claiming to have read omitted content."
      : "文件仍保存在宿主。需要正文时先调用相应的资料读取工具，不得假装已读取未载入内容。",
  ];
  for (const ref of refs) {
    lines.push(`\n- filename: ${ref.filename}`);
    if (ref.id) lines.push(`  id: ${ref.id}`);
    if (ref.mimeType) lines.push(`  mime: ${ref.mimeType}`);
    if (ref.size !== undefined) lines.push(`  size: ${ref.size}`);
    if (ref.storedPath) lines.push(`  stored_path: ${ref.storedPath}`);
    if (ref.extractedPath) lines.push(`  extracted_path: ${ref.extractedPath}`);
  }
  return lines.join("\n");
}
