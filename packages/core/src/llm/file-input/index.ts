export {
  capabilityKeyForModel,
  readFileCapabilityProfile,
  writeFileCapabilityEntry,
  resolveFileInputCapability,
  type CapabilityEntry,
  type CapabilityProfile,
  type FileInputMode,
  type FileProtocol,
  type ModelLike,
  type ResolvedFileCapability,
} from "./capability.js";
export {
  NATIVE_FILE_MARKER_RE,
  encodeNativeFileMarker,
  rewritePayloadWithNativeFiles,
  withNativeFilePayloads,
  type NativeFileMeta,
  type PayloadHookCtx,
} from "./payload-hook.js";
export { buildRichAttachmentBlock, type RichAttachment, type RichAttachmentCtx } from "./attachment-block.js";
export { buildMinimalPdf, probeNativePdfCapability, scheduleLazyPdfProbe, type ProbeResult } from "./probe.js";
