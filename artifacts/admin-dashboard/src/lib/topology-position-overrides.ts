import type { NodeChange, XYPosition } from "@xyflow/react";
import type { ServiceFlowNode } from "../components/ServiceNode";

export function applyPositionChanges(
  overrides: Map<string, XYPosition>,
  changes: NodeChange<ServiceFlowNode>[],
): Map<string, XYPosition> {
  const next = new Map(overrides);
  let changed = false;

  changes.forEach((change) => {
    if (change.type === "position" && change.position !== undefined) {
      next.set(change.id, change.position);
      changed = true;
    }
  });

  return changed ? next : overrides;
}

export function prunePositionOverrides(
  overrides: Map<string, XYPosition>,
  moduleIds: Set<string>,
): Map<string, XYPosition> {
  const next = new Map(
    Array.from(overrides).filter(([id]) => moduleIds.has(id)),
  );

  return next.size === overrides.size ? overrides : next;
}
