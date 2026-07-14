import {
  BaseEdge,
  getSmoothStepPath,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import { motion } from "framer-motion";
import type { HealthStatus } from "../types/dashboard";

const edgeColors: Record<HealthStatus, string> = {
  healthy: "#22c55e",
  warning: "#f59e0b",
  degraded: "#ef4444",
  unknown: "#94a3b8",
};

const edgeDashes: Record<HealthStatus, string | undefined> = {
  healthy: undefined,
  warning: "8 6",
  degraded: "4 5",
  unknown: "2 6",
};

export interface FlowingEdgeData extends Record<string, unknown> {
  status: HealthStatus;
  motionEnabled: boolean;
}

export type TopologyFlowEdge = Edge<FlowingEdgeData, "flowing">;

export function FlowingEdge(props: EdgeProps<TopologyFlowEdge>) {
  const {
    data,
    markerEnd,
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  } = props;
  const status = data?.status ?? "unknown";
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 8,
  });
  const color = edgeColors[status];

  return (
    <>
      <BaseEdge
        path={edgePath}
        label={props.label}
        labelX={labelX}
        labelY={labelY}
        markerEnd={markerEnd}
        style={{
          stroke: color,
          strokeDasharray: edgeDashes[status],
          strokeWidth: 2,
        }}
      />
      {data?.motionEnabled ? (
        <motion.path
          d={edgePath}
          fill="none"
          stroke={color}
          strokeWidth={3}
          strokeLinecap="round"
          strokeDasharray="5 24"
          pointerEvents="none"
          initial={{
            strokeDashoffset: 0,
            opacity: status === "warning" ? 0.55 : 0.8,
          }}
          animate={{
            strokeDashoffset: -58,
            opacity: status === "warning" ? [0.55, 1, 0.55] : 0.8,
          }}
          transition={{
            strokeDashoffset: {
              duration: 1.8,
              ease: "linear",
              repeat: Infinity,
            },
            opacity: { duration: 3.2, ease: "easeInOut", repeat: Infinity },
          }}
        />
      ) : null}
    </>
  );
}
