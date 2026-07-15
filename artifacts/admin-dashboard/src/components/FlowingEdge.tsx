import {
  Position,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import { motion } from "framer-motion";
import {
  buildConnectorGeometry,
  CONDUCTOR_WIDTH,
} from "../lib/topology-connector-geometry";
import type { HealthStatus } from "../types/dashboard";

const edgeColors: Record<HealthStatus, string> = {
  healthy: "#22c55e",
  warning: "#f59e0b",
  degraded: "#ef4444",
  unknown: "#94a3b8",
};

const sharedLaneOffsets: Partial<Record<HealthStatus, number>> = {
  warning: -1.5,
  degraded: 1.5,
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
  renderSharedTrunk?: boolean;
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
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  } = props;
  const status = data?.status ?? "unknown";
  const sharedStatuses = data?.sharedStatuses ?? [];
  const geometry = buildConnectorGeometry({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    sharedSource: sharedStatuses.length > 0,
  });
  const color = edgeColors[status];
  const labelText = getLabelText(props.label);
  const contactOffset = contactOffsets[status];
  const connectedFill = color;
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
  const {
    strokeDasharray: _strokeDasharray,
    opacity: _opacity,
    ...edgeStyle
  } = props.style ?? {};
  return (
    <>
      <path
        className="topology-edge-conductor"
        d={geometry.sourcePath}
        fill="none"
        stroke={color}
        strokeWidth={CONDUCTOR_WIDTH}
        strokeLinecap="butt"
        style={{
          ...edgeStyle,
          stroke: color,
          strokeWidth: CONDUCTOR_WIDTH,
        }}
      />
      <path
        className="topology-edge-conductor"
        d={geometry.targetStubPath}
        fill="none"
        stroke={color}
        strokeWidth={CONDUCTOR_WIDTH}
        strokeLinecap="butt"
        style={{
          ...edgeStyle,
          stroke: color,
          strokeWidth: CONDUCTOR_WIDTH,
        }}
      />
      {data?.renderSharedTrunk === true && geometry.sharedTrunkPath !== undefined ? (
        <>
          <path
            className="topology-edge-shared-trunk"
            d={geometry.sharedTrunkPath}
            fill="none"
            stroke={edgeColors.healthy}
            strokeWidth={CONDUCTOR_WIDTH}
            strokeLinecap="butt"
          />
          {sharedStatuses.map((sharedStatus) => {
            const offset = sharedLaneOffsets[sharedStatus];
            if (offset === undefined) return null;
            return (
              <path
                key={sharedStatus}
                className="topology-edge-shared-trunk"
                d={geometry.sharedTrunkPath}
                fill="none"
                stroke={edgeColors[sharedStatus]}
                strokeWidth={1.5}
                strokeLinecap="butt"
                transform={`translate(0 ${offset})`}
              />
            );
          })}
        </>
      ) : null}
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
        data-offset={contactOffset}
        transform={`translate(${geometry.contactX} ${geometry.contactY})`}
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
            d={`M -${CONTACT_HALF_LENGTH} -3 H ${sourceFaceX} V -1.15 H ${sourceSlotX} V 1.15 H ${sourceFaceX} V 3 H -${CONTACT_HALF_LENGTH} Z`}
            strokeWidth={0}
            style={{ fill: connectedFill }}
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
            d={`M ${CONTACT_HALF_LENGTH} -3 H ${targetBodyX} V -0.75 H ${targetTongueX} V 0.75 H ${targetBodyX} V 3 H ${CONTACT_HALF_LENGTH} Z`}
            strokeWidth={0}
            style={{ fill: connectedFill }}
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
