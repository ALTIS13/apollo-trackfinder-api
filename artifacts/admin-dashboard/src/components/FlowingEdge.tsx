import {
  BaseEdge,
  getSmoothStepPath,
  Position,
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

const contactStates = {
  healthy: "connected",
  warning: "unstable",
  degraded: "disconnected",
  unknown: "unknown",
} as const satisfies Record<HealthStatus, string>;

const contactOffsets: Record<HealthStatus, number> = {
  healthy: 0,
  warning: 3,
  degraded: 7,
  unknown: 6,
};

const CONTACT_HALF_LENGTH = 16;
const CABLE_STROKE_WIDTH = 4.5;
const TARGET_LINE_STUB = 12;
const EDGE_BEND_RADIUS = 7.5;
const EDGE_ENDPOINT_OFFSET = TARGET_LINE_STUB;
const STATUS_BADGE_ABOVE_Y = -58;
const STATUS_BADGE_BELOW_Y = 44;
const STATUS_BADGE_TEXT_OFFSET = 7;
const MAX_VISIBLE_STATUS_CODE_LENGTH = 12;

export interface FlowingEdgeDiagnostic extends Record<string, unknown> {
  incidentId: string;
  code?: string;
  message: string;
}

export interface FlowingEdgeData extends Record<string, unknown> {
  status: HealthStatus;
  motionEnabled: boolean;
  actionable?: boolean;
  diagnostic?: FlowingEdgeDiagnostic;
  sharedStatuses?: HealthStatus[];
}

export type TopologyFlowEdge = Edge<FlowingEdgeData, "flowing">;

function getLabelText(label: EdgeProps<TopologyFlowEdge>["label"]) {
  return typeof label === "string" || typeof label === "number"
    ? String(label)
    : undefined;
}

function getStatusText(status: HealthStatus, code?: string) {
  const visibleCode =
    code === undefined || code.length <= MAX_VISIBLE_STATUS_CODE_LENGTH
      ? code
      : `${code.slice(0, MAX_VISIBLE_STATUS_CODE_LENGTH - 3)}...`;
  if (status === "warning")
    return visibleCode === undefined ? "WARNING" : `WARNING ${visibleCode}`;
  if (status === "degraded")
    return visibleCode === undefined ? "ERROR" : `ERROR ${visibleCode}`;
  if (status === "unknown") return "NO DATA";
  return undefined;
}

export function getEdgeAccessibleLabel(
  status: HealthStatus,
  code: string | undefined,
  canOpen: boolean,
) {
  const action = canOpen ? ". Открыть журнал" : "";
  if (status === "degraded") {
    return code === undefined
      ? `Соединение разорвано${action}`
      : `Соединение разорвано, ошибка ${code}${action}`;
  }
  if (status === "warning") {
    return code === undefined
      ? `Нестабильное соединение${action}`
      : `Нестабильное соединение, предупреждение ${code}${action}`;
  }
  if (status === "unknown") return "Нет данных о соединении";
  return "Соединение работает";
}

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
  const usesHorizontalRouting =
    sourcePosition === Position.Right &&
    targetPosition === Position.Left &&
    sourceX < targetX;
  const contactApproachX =
    targetX - CONTACT_HALF_LENGTH * 2 - TARGET_LINE_STUB;
  const routeCenterX = usesHorizontalRouting
    ? Math.max(
        sourceX + EDGE_ENDPOINT_OFFSET + EDGE_BEND_RADIUS,
        contactApproachX - EDGE_BEND_RADIUS,
      )
    : undefined;
  const [edgePath] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: EDGE_BEND_RADIUS,
    centerX: routeCenterX,
    offset: routeCenterX === undefined ? undefined : EDGE_ENDPOINT_OFFSET,
  });
  const color = edgeColors[status];
  const labelText = getLabelText(props.label);
  const contactX = targetX - CONTACT_HALF_LENGTH - TARGET_LINE_STUB;
  const contactY = targetY;
  const contactOffset = contactOffsets[status];
  const connectedFill = status === "healthy" ? color : undefined;
  const sourceFaceX = -contactOffset;
  const sourceSlotX = sourceFaceX - 6;
  const targetBodyX = 1 + contactOffset;
  const targetTongueX = -5 + contactOffset;
  const diagnostic = data?.diagnostic;
  const canOpenIncident = diagnostic !== undefined && data?.actionable === true;
  const statusText = getStatusText(status, diagnostic?.code);
  const statusWidth =
    statusText === undefined
      ? 0
      : Math.min(104, Math.max(46, statusText.length * 5.4 + 12));
  const statusBadgeY =
    targetY < sourceY ? STATUS_BADGE_BELOW_Y : STATUS_BADGE_ABOVE_Y;
  const sharedStatuses = data?.sharedStatuses ?? [];
  const sharedGradientId = `topology-shared-${props.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const sharedTrunkEndX =
    routeCenterX === undefined ? undefined : routeCenterX - EDGE_BEND_RADIUS;
  return (
    <>
      <BaseEdge
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...props.style,
          stroke: color,
          strokeDasharray: edgeDashes[status],
          strokeWidth: CABLE_STROKE_WIDTH,
        }}
      />
      {sharedStatuses.length > 1 && sharedTrunkEndX !== undefined ? (
        <>
          <defs>
            <linearGradient
              id={sharedGradientId}
              className="topology-edge-shared-gradient"
              gradientUnits="userSpaceOnUse"
              x1={sourceX}
              y1={sourceY}
              x2={sharedTrunkEndX}
              y2={sourceY}
            >
              {sharedStatuses.map((sharedStatus, index) => (
                <stop
                  key={sharedStatus}
                  offset={`${(index / (sharedStatuses.length - 1)) * 100}%`}
                  stopColor={edgeColors[sharedStatus]}
                />
              ))}
            </linearGradient>
          </defs>
          <path
            className="topology-edge-shared-trunk"
            d={`M ${sourceX} ${sourceY} H ${sharedTrunkEndX}`}
            fill="none"
            stroke={`url(#${sharedGradientId})`}
            style={{
              opacity: props.style?.opacity,
              strokeWidth: CABLE_STROKE_WIDTH,
            }}
          />
        </>
      ) : null}
      <g
        className="topology-edge-contact-route-occlusion"
        aria-hidden="true"
        transform={`translate(${contactX} ${contactY})`}
        pointerEvents="none"
      >
        <rect
          className="topology-edge-contact-route-cover"
          x={-CONTACT_HALF_LENGTH}
          y={-3}
          width={CONTACT_HALF_LENGTH * 2}
          height={6}
          fill="var(--color-surface)"
        />
      </g>
      <g
        className="topology-edge-contact"
        data-state={contactStates[status]}
        data-actionable={canOpenIncident ? "true" : undefined}
        role="presentation"
        aria-label={getEdgeAccessibleLabel(
          status,
          diagnostic?.code,
          canOpenIncident,
        )}
        transform={`translate(${contactX} ${contactY})`}
        style={{ opacity: props.style?.opacity }}
      >
        <title>
          {diagnostic?.message ??
            getEdgeAccessibleLabel(status, undefined, false)}
        </title>
        <rect
          className="topology-edge-contact-hitbox"
          x={-34}
          y={-30}
          width={68}
          height={54}
          rx={6}
        />

        <g
          className="topology-edge-plug-half topology-edge-plug-half--source topology-edge-contact-female"
          data-contact-kind="female"
        >
          <path
            className="topology-edge-contact-rail"
            d={`M -${CONTACT_HALF_LENGTH} -2.25 H ${sourceFaceX} V -1.15 H ${sourceSlotX} V 1.15 H ${sourceFaceX} V 2.25 H -${CONTACT_HALF_LENGTH} Z`}
            style={{ fill: connectedFill, stroke: color }}
          />
          <path
            className="topology-edge-contact-notch"
            d={`M ${sourceFaceX} -1.15 H ${sourceSlotX} V 1.15 H ${sourceFaceX}`}
            style={{ stroke: color }}
          />
        </g>

        <g
          className="topology-edge-plug-half topology-edge-plug-half--target topology-edge-contact-male"
          data-contact-kind="male"
        >
          <path
            className="topology-edge-contact-rail"
            d={`M ${CONTACT_HALF_LENGTH} -2.25 H ${targetBodyX} V -0.75 H ${targetTongueX} V 0.75 H ${targetBodyX} V 2.25 H ${CONTACT_HALF_LENGTH} Z`}
            style={{ fill: connectedFill, stroke: color }}
          />
          <path
            className="topology-edge-contact-tongue"
            d={`M ${targetTongueX} -0.75 H ${targetBodyX} V 0.75 H ${targetTongueX}`}
            style={{ stroke: color }}
          />
        </g>

        {status === "warning" && data?.motionEnabled ? (
          <motion.path
            className="topology-edge-warning-spark"
            d="M -1 -4 L 2 -1 L -1 1 L 2 4"
            fill="none"
            stroke={color}
            strokeWidth={1.5}
            strokeLinecap="round"
            initial={{ opacity: 0.25 }}
            animate={{ opacity: [0.25, 1, 0.25] }}
            transition={{ duration: 0.8, ease: "easeInOut", repeat: Infinity }}
          />
        ) : null}

        {statusText === undefined ? null : (
          <g className="topology-edge-contact-status">
            <rect
              x={-statusWidth / 2}
              y={statusBadgeY}
              width={statusWidth}
              height={14}
              rx={3}
            />
            <text
              x={0}
              y={statusBadgeY + STATUS_BADGE_TEXT_OFFSET}
              data-status={status}
            >
              {statusText}
            </text>
          </g>
        )}

        {labelText === undefined ? null : (
          <text className="topology-edge-traffic" x={0} y={19}>
            {labelText}
          </text>
        )}
      </g>
    </>
  );
}
