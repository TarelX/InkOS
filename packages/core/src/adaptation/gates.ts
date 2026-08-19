/**
 * Adaptation fidelity gates — hard constraints, programmatically checked
 * (ADR-006). Rubric scoring lives with the LLM auditors; these gates hold
 * the veto.
 */

import type { CausalEdge } from "../story-intelligence/schemas/graph.js";
import type { GateResult } from "../workflow/engine.js";
import type { AdaptationContract, CharacterMapEntry, EventDecision } from "./schemas.js";

/** B1: every must_preserve source event maps to at least one target event. */
export function contractCoverageGate(
  contract: AdaptationContract,
  decisions: ReadonlyArray<EventDecision>,
): GateResult {
  const byEvent = new Map(decisions.map((d) => [d.sourceEventId, d]));
  const violations: string[] = [];
  for (const item of contract.mustPreserve) {
    if (item.kind !== "event") continue;
    const decision = byEvent.get(item.refId);
    if (!decision) {
      violations.push(`must_preserve 事件 ${item.refId} 没有任何映射决策`);
      continue;
    }
    if (decision.decision === "remove") {
      violations.push(`must_preserve 事件 ${item.refId} 被标记为 remove（${decision.reason}）`);
      continue;
    }
    if (decision.targetEventIds.length === 0) {
      violations.push(`must_preserve 事件 ${item.refId} 的决策 ${decision.decision} 缺少 target 事件`);
    }
  }
  return { pass: violations.length === 0, hardViolations: violations };
}

/**
 * B3: removing a middle node of a strong causal chain requires an explicit
 * replacement note describing how the causal load is carried in the target.
 */
export function causalIntegrityGate(
  edges: ReadonlyArray<CausalEdge>,
  decisions: ReadonlyArray<EventDecision>,
): GateResult {
  const strongIn = new Set<string>();
  const strongOut = new Set<string>();
  for (const edge of edges) {
    if (edge.strength !== "strong") continue;
    strongIn.add(edge.toEventId);
    strongOut.add(edge.fromEventId);
  }
  const violations: string[] = [];
  for (const decision of decisions) {
    if (decision.decision !== "remove") continue;
    const isMiddle = strongIn.has(decision.sourceEventId) && strongOut.has(decision.sourceEventId);
    if (isMiddle && !decision.replacementNote?.trim()) {
      violations.push(
        `事件 ${decision.sourceEventId} 处于强因果链中段却被 remove 且无 replacementNote —— 后续事件将失去动机`,
      );
    }
  }
  return { pass: violations.length === 0, hardViolations: violations };
}

/** B4: every major target role traces to a source entity, an approved merge, or an approved invention. */
export function roleProvenanceGate(entries: ReadonlyArray<CharacterMapEntry>): GateResult {
  const violations: string[] = [];
  const targetNames = new Set(entries.map((e) => e.targetName));
  for (const entry of entries) {
    if (entry.tier !== "major") continue;
    switch (entry.strategy) {
      case "rename":
      case "keep_name":
        if (!entry.sourceEntityId && !entry.sourceName) {
          violations.push(`主要角色 ${entry.targetName} 声称改名/保名但缺少源实体`);
        }
        break;
      case "merge_into":
        if (!entry.mergedIntoTargetName || !targetNames.has(entry.mergedIntoTargetName)) {
          violations.push(`主要角色 ${entry.targetName} 的合并目标缺失或不存在`);
        }
        break;
      case "invent":
        if (!entry.approvedInvention) {
          violations.push(`主要角色 ${entry.targetName} 是未经批准的发明角色（invent 未获人工确认）`);
        }
        break;
      case "drop":
        violations.push(`主要角色 ${entry.targetName} 不能既是 major 又被 drop —— 降级为 minor 或改为 merge`);
        break;
    }
  }
  return { pass: violations.length === 0, hardViolations: violations };
}

/** Combine sub-gates into one workflow gate result. */
export function combineGates(...results: ReadonlyArray<GateResult>): GateResult {
  return {
    pass: results.every((r) => r.pass),
    hardViolations: results.flatMap((r) => [...r.hardViolations]),
  };
}
