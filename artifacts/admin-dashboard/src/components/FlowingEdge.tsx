import {
  Position,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import { motion } from "framer-motion";
import { buildConnectorGeometry } from "../lib/topology-connector-geometry";
import { CONNECTOR_VISUAL_METRICS } from "../lib/topology-evidence-layout";
import { buildStatusGradientStops } from "../lib/topology-status-gradient";
import type { SharedStatusBand } from "../lib/topology-shared-routes";
import type { HealthStatus } from "../types/dashboard";

const edgeColors: Record<HealthStatus, string> = {
  healthy: "#22c55e",
  warning: "#f59e0b",
  degraded: "#ef4444",
  unknown: "#94a3b8",
};

const ROUTE_COLOR = "#596273";
const ROUTE_WIDTH = CONNECTOR_VISUAL_METRICS.routeWidth;
const STATUS_LANE_WIDTH = 1;

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
const STATUS_BADGE_BASE_Y = -36;
const STATUS_BADGE_LANE_STEP = 18;
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
  sharedStatusBands?: SharedStatusBand[];
  sharedBranchLength?: number;
  renderSharedTrunk?: boolean;
  branchAttachmentY?: number;
  branchChannel?: number;
  branchApproachX?: number;
  sharedFanMinimumY?: number;
  sharedFanMaximumY?: number;
  evidenceLane?: number;
}

export type TopologyFlowEdge = Edge<FlowingEdgeData, "flowing">;

function getLabelText(label: EdgeProps<TopologyFlowEdge>["label"]) {
  return typeof label === "string" || typeof label === "number"
    ? String(label)
    : undefined;
}

function getGradientId(edgeId: string): string {
  const encodedId = edgeId.replace(/[^a-zA-Z0-9-]/g, (character) =>
    `_${character.codePointAt(0)!.toString(16)}_`,
  );
  return `topology-gradient-${encodedId}`;
}

export function getEvidenceLabelText(status: HealthStatus, code?: string) {
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

export function getEvidenceLabelWidth(statusText: string): number {
  return Math.min(104, Math.max(46, statusText.length * 5.4 + 12));
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
  const sharedStatusBands = data?.sharedStatusBands ?? [];
  const gradientStops = buildStatusGradientStops(sharedStatusBands);
  const gradientId = getGradientId(props.id);
  const geometry = buildConnectorGeometry({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    sharedBranchLength: data?.sharedBranchLength,
    branchAttachmentY: data?.branchAttachmentY,
    branchChannel: data?.branchChannel,
    branchApproachX: data?.branchApproachX,
    sharedFanMinimumY: data?.sharedFanMinimumY,
    sharedFanMaximumY: data?.sharedFanMaximumY,
  });
  const color = edgeColors[status];
  const labelText = getLabelText(props.label);
  const contactOffset = contactOffsets[status];
  const connectedFill = color;
  const sourceFaceX = -contactOffset;
  const sourceSlotX = sourceFaceX - 6;
  const targetBodyX = 1 + contactOffset;
  const targetTongueX = -5 + contactOffset;
  const sourceRailPath = `M -${CONTACT_HALF_LENGTH} -3 H ${sourceFaceX} V -1.15 H ${sourceSlotX} V 1.15 H ${sourceFaceX} V 3 H -${CONTACT_HALF_LENGTH} Z`;
  const targetRailPath = `M ${CONTACT_HALF_LENGTH} -3 H ${targetBodyX} V -0.75 H ${targetTongueX} V 0.75 H ${targetBodyX} V 3 H ${CONTACT_HALF_LENGTH} Z`;
  const diagnostic = data?.diagnostic;
  const canOpenIncident = diagnostic !== undefined && data?.actionable === true;
  const statusText = getEvidenceLabelText(status, diagnostic?.code);
  const statusWidth =
    statusText === undefined
      ? 0
      : getEvidenceLabelWidth(statusText);
  const statusBadgeY =
    STATUS_BADGE_BASE_Y - (data?.evidenceLane ?? 0) * STATUS_BADGE_LANE_STEP;
  const {
    strokeDasharray: _strokeDasharray,
    opacity: _opacity,
    ...edgeStyle
  } = props.style ?? {};
  return (
    <>
      <path
        className="topology-edge-conductor topology-edge-conductor-base"
        d={geometry.sourcePath}
        fill="none"
        stroke={ROUTE_COLOR}
        strokeWidth={ROUTE_WIDTH}
        strokeLinecap="butt"
        style={{
          ...edgeStyle,
          stroke: ROUTE_COLOR,
          strokeWidth: ROUTE_WIDTH,
        }}
      />
      <path
        className="topology-edge-status-lane"
        d={geometry.sourcePath}
        fill="none"
        stroke={color}
        strokeWidth={STATUS_LANE_WIDTH}
        strokeLinecap="butt"
        style={{
          ...edgeStyle,
          stroke: color,
          strokeWidth: STATUS_LANE_WIDTH,
        }}
      />
      <path
        className="topology-edge-conductor topology-edge-conductor-base"
        d={geometry.targetPath}
        fill="none"
        stroke={ROUTE_COLOR}
        strokeWidth={ROUTE_WIDTH}
        strokeLinecap="butt"
        style={{
          ...edgeStyle,
          stroke: ROUTE_COLOR,
          strokeWidth: ROUTE_WIDTH,
        }}
      />
      <path
        className="topology-edge-status-lane"
        d={geometry.targetPath}
        fill="none"
        stroke={color}
        strokeWidth={STATUS_LANE_WIDTH}
        strokeLinecap="butt"
        style={{
          ...edgeStyle,
          stroke: color,
          strokeWidth: STATUS_LANE_WIDTH,
        }}
      />
      {data?.renderSharedTrunk === true &&
      geometry.sharedTrunkPath !== undefined ? (
        <>
          <path
            className="topology-edge-shared-trunk topology-edge-conductor-base"
            d={geometry.sharedTrunkPath}
            fill="none"
            stroke={ROUTE_COLOR}
            strokeWidth={ROUTE_WIDTH}
            strokeLinecap="butt"
          />
          {gradientStops.length > 0 ? (
            <>
              <defs>
                <linearGradient
                  id={gradientId}
                  gradientUnits="userSpaceOnUse"
                  x1={geometry.sharedGradientStart.x}
                  y1={geometry.sharedGradientStart.y}
                  x2={geometry.sharedGradientEnd.x}
                  y2={geometry.sharedGradientEnd.y}
                >
                  {gradientStops.map((stop, index) => (
                    <stop
                      key={`${stop.offset}:${stop.status}:${index}`}
                      offset={`${stop.offset * 100}%`}
                      stopColor={edgeColors[stop.status]}
                      stopOpacity={1}
                    />
                  ))}
                </linearGradient>
              </defs>
              <path
                className="topology-edge-shared-trunk topology-edge-status-lane"
                d={geometry.sharedTrunkPath}
                fill="none"
                stroke={`url(#${gradientId})`}
                strokeWidth={STATUS_LANE_WIDTH}
                strokeLinecap="butt"
              />
            </>
          ) : null}
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
          x={-CONNECTOR_VISUAL_METRICS.contactHitHalfWidth}
          y={-CONNECTOR_VISUAL_METRICS.contactHitTop}
          width={CONNECTOR_VISUAL_METRICS.contactHitHalfWidth * 2}
          height={
            CONNECTOR_VISUAL_METRICS.contactHitTop +
            CONNECTOR_VISUAL_METRICS.contactHitBottom
          }
          rx={6}
        />

        <g
          className="topology-edge-plug-half topology-edge-plug-half--source topology-edge-contact-female"
          data-contact-kind="female"
        >
          <path
            className="topology-edge-contact-rail"
            d={sourceRailPath}
            strokeWidth={0}
            style={{ color, fill: connectedFill }}
          />
          <path
            className="topology-edge-contact-highlight"
            d={`M -14 -1.5 H ${sourceFaceX - 1.5}`}
          />
          <path
            className="topology-edge-contact-notch"
            d={`M ${sourceFaceX} -1.15 H ${sourceSlotX} V 1.15 H ${sourceFaceX}`}
            style={{ stroke: color }}
          />
          <path className="topology-edge-contact-outline" d={sourceRailPath} />
        </g>

        <g
          className="topology-edge-plug-half topology-edge-plug-half--target topology-edge-contact-male"
          data-contact-kind="male"
        >
          <path
            className="topology-edge-contact-rail"
            d={targetRailPath}
            strokeWidth={0}
            style={{ color, fill: connectedFill }}
          />
          <path
            className="topology-edge-contact-highlight"
            d={`M ${targetBodyX + 1.5} -1.5 H 14`}
          />
          <path
            className="topology-edge-contact-tongue"
            d={`M ${targetTongueX} -0.75 H ${targetBodyX} V 0.75 H ${targetTongueX}`}
            style={{ stroke: color }}
          />
          <path className="topology-edge-contact-outline" d={targetRailPath} />
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
          <g
            className="topology-edge-contact-status"
            data-evidence-lane={data?.evidenceLane ?? 0}
          >
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
          <text
            className="topology-edge-traffic"
            x={0}
            y={CONNECTOR_VISUAL_METRICS.trafficLabelCenterY}
          >
            {labelText}
          </text>
        )}
      </g>
    </>
  );
}
