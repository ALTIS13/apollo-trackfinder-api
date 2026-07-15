import { getSmoothStepPath, Position } from "@xyflow/react";

export const CONDUCTOR_WIDTH = 6;
export const CONTACT_HALF_LENGTH = 16;
export const TARGET_STUB_LENGTH = 12;
export const SHARED_TRUNK_LENGTH = 24;
export const CONNECTOR_BEND_RADIUS = 7.5;

function buildBoundedOrthogonalPath(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
): string {
  const midpointX = (sourceX + targetX) / 2;
  return `M${sourceX} ${sourceY} L${midpointX} ${sourceY} L${midpointX} ${targetY} L${targetX} ${targetY}`;
}

export interface ConnectorGeometryInput {
  sourceX: number;
  sourceY: number;
  sourcePosition: Position;
  targetX: number;
  targetY: number;
  targetPosition: Position;
  sharedBranchLength?: number;
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
  const sharedBranchLength = Math.max(0, input.sharedBranchLength ?? 0);
  const branchSourceX = input.sourceX + sharedBranchLength;
  const usesBoundedRightToLeftRoute =
    input.sourcePosition === Position.Right &&
    input.targetPosition === Position.Left &&
    femaleOuterX - branchSourceX < TARGET_STUB_LENGTH * 2;
  const sourcePath = usesBoundedRightToLeftRoute
    ? buildBoundedOrthogonalPath(
        branchSourceX,
        input.sourceY,
        femaleOuterX,
        input.targetY,
      )
    : getSmoothStepPath({
        sourceX: branchSourceX,
        sourceY: input.sourceY,
        sourcePosition: input.sourcePosition,
        targetX: femaleOuterX,
        targetY: input.targetY,
        targetPosition: input.targetPosition,
        borderRadius: CONNECTOR_BEND_RADIUS,
        offset: TARGET_STUB_LENGTH,
      })[0];

  return {
    sourcePath,
    targetStubPath: `M ${maleOuterX} ${input.targetY} H ${input.targetX}`,
    contactX,
    contactY: input.targetY,
    femaleOuterX,
    maleOuterX,
    branchSourceX,
    sharedTrunkPath:
      sharedBranchLength > 0
        ? `M ${input.sourceX} ${input.sourceY} H ${branchSourceX}`
        : undefined,
  };
}
