import { getSmoothStepPath, Position } from "@xyflow/react";

export const CONDUCTOR_WIDTH = 6;
export const CONTACT_HALF_LENGTH = 16;
export const TARGET_STUB_LENGTH = 12;
export const SHARED_TRUNK_LENGTH = 24;

export interface ConnectorGeometryInput {
  sourceX: number;
  sourceY: number;
  sourcePosition: Position;
  targetX: number;
  targetY: number;
  targetPosition: Position;
  sharedSource: boolean;
}

export interface ConnectorGeometry {
  sourcePath: string;
  targetStubPath: string;
  contactX: number;
  contactY: number;
  femaleOuterX: number;
  maleOuterX: number;
  branchSourceX: number;
  sharedTrunkPath?: string;
}

export function buildConnectorGeometry(input: ConnectorGeometryInput): ConnectorGeometry {
  const contactX = input.targetX - CONTACT_HALF_LENGTH - TARGET_STUB_LENGTH;
  const femaleOuterX = contactX - CONTACT_HALF_LENGTH;
  const maleOuterX = contactX + CONTACT_HALF_LENGTH;
  const canShare =
    input.sharedSource &&
    input.sourcePosition === Position.Right &&
    input.targetPosition === Position.Left &&
    femaleOuterX > input.sourceX + SHARED_TRUNK_LENGTH + 7.5;
  const branchSourceX = canShare ? input.sourceX + SHARED_TRUNK_LENGTH : input.sourceX;
  const [sourcePath] = getSmoothStepPath({
    sourceX: branchSourceX,
    sourceY: input.sourceY,
    sourcePosition: input.sourcePosition,
    targetX: femaleOuterX,
    targetY: input.targetY,
    targetPosition: input.targetPosition,
    borderRadius: 7.5,
    offset: TARGET_STUB_LENGTH,
  });

  return {
    sourcePath,
    targetStubPath: `M ${maleOuterX} ${input.targetY} H ${input.targetX}`,
    contactX,
    contactY: input.targetY,
    femaleOuterX,
    maleOuterX,
    branchSourceX,
    sharedTrunkPath: canShare ? `M ${input.sourceX} ${input.sourceY} H ${branchSourceX}` : undefined,
  };
}
