import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { motion } from "framer-motion";
import {
  Braces,
  Cloud,
  Database,
  Download,
  Globe2,
  Layers3,
  Puzzle,
  Search,
} from "lucide-react";
import { memo } from "react";
import type { ServiceModule } from "../types/dashboard";

const statusLabels = {
  healthy: "Работает",
  warning: "Предупреждение",
  degraded: "Деградация",
  unknown: "Нет данных",
} as const;
const serviceIcons = {
  "public-web": Globe2,
  "core-api": Braces,
  "account-integrations": Puzzle,
  "search-media": Search,
  "download-worker": Download,
  postgresql: Database,
  redis: Layers3,
  "media-storage": Cloud,
} as const;

export interface ServiceNodeData extends Record<string, unknown> {
  module: ServiceModule;
  motionEnabled: boolean;
}

export type ServiceFlowNode = Node<ServiceNodeData, "service">;

function ServiceNodeComponent({ data, selected }: NodeProps<ServiceFlowNode>) {
  const { module, motionEnabled } = data;
  const pulse = module.status === "degraded" && motionEnabled;
  const ServiceIcon =
    serviceIcons[module.id as keyof typeof serviceIcons] ?? Layers3;

  return (
    <div className="service-node-root">
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        aria-hidden="true"
      />
      <span
        className="service-node-terminal service-node-terminal--target"
        data-status={module.status}
        aria-hidden="true"
      />
      <button
        type="button"
        className="service-node nodrag nopan"
        data-status={module.status}
        aria-label={module.name}
        aria-pressed={selected}
      >
        <span className="service-node-icon" aria-hidden="true"><ServiceIcon /></span>
        <span className="service-node-content">
          <span className="service-node-heading">
            <span>{module.name}</span>
            <motion.span
              className="service-status-dot"
              data-status={module.status}
              aria-hidden="true"
              animate={
                pulse
                  ? { opacity: [0.55, 1, 0.55], scale: [1, 1.2, 1] }
                  : undefined
              }
              transition={
                pulse
                  ? { duration: 2.4, repeat: Infinity, ease: "easeInOut" }
                  : undefined
              }
            />
          </span>
          <span className="service-node-meta">
            {module.id} · v{module.version}
          </span>
          <span className="service-node-status">
            {statusLabels[module.status]} · {module.requestsPerMinute}/мин
          </span>
        </span>
      </button>
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        aria-hidden="true"
      />
      <span
        className="service-node-terminal service-node-terminal--source"
        data-status={module.status}
        aria-hidden="true"
      />
    </div>
  );
}

export const ServiceNode = memo(ServiceNodeComponent);
