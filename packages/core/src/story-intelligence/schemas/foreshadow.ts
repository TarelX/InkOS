/**
 * Foreshadow / mystery / payoff ledger.
 * setup → reminder* → payoff, with an explicit payoff window and overdue
 * detection instead of "the model probably remembers".
 */

import { z } from "zod";
import { ConfidenceStatusSchema, SourceRefSchema } from "./source-ref.js";

export const ForeshadowTypeSchema = z.enum(["mystery", "setup", "chekhov", "promise"]);
export type ForeshadowType = z.infer<typeof ForeshadowTypeSchema>;

export const ForeshadowStatusSchema = z.enum(["open", "reminded", "paid", "overdue", "abandoned"]);
export type ForeshadowStatus = z.infer<typeof ForeshadowStatusSchema>;

export const ForeshadowSchema = z.object({
  id: z.string().regex(/^hook_[0-9a-f]{12}$/),
  bookId: z.string().min(1),
  type: ForeshadowTypeSchema,
  intent: z.string().min(1),
  setupEventId: z.string(),
  reminderEventIds: z.array(z.string()).default([]),
  payoffEventId: z.string().nullable().default(null),
  /** Inclusive chapter window in which the payoff is expected. */
  payoffWindow: z
    .object({ fromChapter: z.number().int().positive(), toChapter: z.number().int().positive() })
    .nullable()
    .default(null),
  importance: z.number().min(0).max(1).default(0.5),
  status: ForeshadowStatusSchema.default("open"),
  evidence: z.array(SourceRefSchema).default([]),
  reviewStatus: ConfidenceStatusSchema.default("candidate"),
});
export type Foreshadow = z.infer<typeof ForeshadowSchema>;

/** Derive ledger status from graph facts + current chapter cursor. */
export function deriveForeshadowStatus(
  hook: Pick<Foreshadow, "payoffEventId" | "reminderEventIds" | "payoffWindow" | "status">,
  currentChapter: number,
): ForeshadowStatus {
  if (hook.status === "abandoned") return "abandoned";
  if (hook.payoffEventId) return "paid";
  if (hook.payoffWindow && currentChapter > hook.payoffWindow.toChapter) return "overdue";
  if (hook.reminderEventIds.length > 0) return "reminded";
  return "open";
}
