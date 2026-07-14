import {
  Background,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type EdgeTypes,
  type NodeTypes,
} from "@xyflow/react";
import { Maximize2, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import { useReducedMotion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import { getServiceNeighborhood } from "../lib/dashboard-model";
import { layoutTopology } from "../lib/topology-layout";
import type { DashboardSnapshot, HealthStatus } from "../types/dashboard";
import { FlowingEdge, type TopologyFlowEdge } from "./FlowingEdge";
import { ServiceNode, type ServiceFlowNode } from "./ServiceNode";

const nodeTypes: NodeTypes = { service: ServiceNode };
const edgeTypes: EdgeTypes = { flowing: FlowingEdge };
const statusLabels: Record<HealthStatus, string> = {
  healthy: "Работает",
  warning: "Предупреждение",
  degraded: "Деградация",
  unknown: "Нет данных",
};

export function formatTrafficLabel(requestsPerMinute: number): string {
  return `${requestsPerMinute}/мин`;
}

interface TopologyPanelProps {
  snapshot: DashboardSnapshot;
  selectedServiceId?: string;
  neighborhood?: Set<string>;
  onSelectService: (serviceId?: string) => void;
}

function useDocumentVisible() {
  const [visible, setVisible] = useState(
    () => document.visibilityState !== "hidden",
  );

  useEffect(() => {
    const updateVisibility = () =>
      setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", updateVisibility);
    return () =>
      document.removeEventListener("visibilitychange", updateVisibility);
  }, []);

  return visible;
}

function ViewportControls({ reducedMotion }: { reducedMotion: boolean }) {
  const { fitView, zoomIn, zoomOut } = useReactFlow();
  const duration = reducedMotion ? 0 : 160;

  return (
    <div className="topology-controls" aria-label="Масштаб топологии">
      <button
        type="button"
        aria-label="Увеличить"
        onClick={() => void zoomIn({ duration })}
      >
        <ZoomIn aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label="Уменьшить"
        onClick={() => void zoomOut({ duration })}
      >
        <ZoomOut aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label="Вписать топологию"
        onClick={() => void fitView({ duration, padding: 0.12 })}
      >
        <Maximize2 aria-hidden="true" />
      </button>
    </div>
  );
}

function TopologyCanvas({
  snapshot,
  selectedServiceId,
  neighborhood,
  onSelectService,
}: TopologyPanelProps) {
  const reducedMotion = useReducedMotion() ?? false;
  const documentVisible = useDocumentVisible();
  const layout = useMemo(
    () => layoutTopology(snapshot.modules, snapshot.edges),
    [snapshot.edges, snapshot.modules],
  );
  const fallbackNeighborhood = useMemo(
    () =>
      selectedServiceId === undefined
        ? undefined
        : getServiceNeighborhood(snapshot, selectedServiceId),
    [selectedServiceId, snapshot.edges],
  );
  const activeNeighborhood = neighborhood ?? fallbackNeighborhood;
  const nodes = useMemo<ServiceFlowNode[]>(() => {
    const positions = new Map(layout.nodes.map((node) => [node.id, node]));
    return snapshot.modules.map((module) => {
      const position = positions.get(module.id);
      if (position === undefined)
        throw new Error(`Не найдена позиция сервиса ${module.id}`);
      return {
        id: module.id,
        type: "service",
        position: { x: position.x, y: position.y },
        width: position.width,
        height: position.height,
        selected: module.id === selectedServiceId,
        draggable: false,
        data: {
          module,
          dimmed:
            activeNeighborhood !== undefined &&
            !activeNeighborhood.has(module.id),
          motionEnabled: documentVisible && !reducedMotion,
          onSelect: onSelectService,
        },
      };
    });
  }, [
    activeNeighborhood,
    documentVisible,
    layout.nodes,
    onSelectService,
    reducedMotion,
    selectedServiceId,
    snapshot.modules,
  ]);
  const edges = useMemo<TopologyFlowEdge[]>(
    () =>
      snapshot.edges.map((edge) => ({
        id: edge.id,
        type: "flowing",
        source: edge.source,
        target: edge.target,
        label: formatTrafficLabel(edge.requestsPerMinute),
        markerEnd: { type: MarkerType.ArrowClosed, color: "currentColor" },
        data: {
          status: edge.status,
          motionEnabled:
            edge.requestsPerMinute > 0 &&
            documentVisible &&
            !reducedMotion &&
            (selectedServiceId === undefined ||
              edge.source === selectedServiceId ||
              edge.target === selectedServiceId),
        },
        style: {
          opacity:
            selectedServiceId === undefined ||
            edge.source === selectedServiceId ||
            edge.target === selectedServiceId
              ? 1
              : 0.28,
        },
      })),
    [documentVisible, reducedMotion, selectedServiceId, snapshot.edges],
  );

  return (
    <div className="topology-canvas">
      <ReactFlow<ServiceFlowNode, TopologyFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.12 }}
        minZoom={0.45}
        maxZoom={1.6}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        onPaneClick={() => onSelectService(undefined)}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} size={1} />
        <ViewportControls reducedMotion={reducedMotion} />
      </ReactFlow>
    </div>
  );
}

export function TopologyPanel(props: TopologyPanelProps) {
  return (
    <section className="topology-panel" aria-label="Топология сервисов">
      <header className="topology-panel-header">
        <h2>Топология сервисов</h2>
        <div className="status-legend" aria-label="Статусы">
          {(Object.keys(statusLabels) as HealthStatus[]).map((status) => (
            <span key={status} data-status={status}>
              {statusLabels[status]}
            </span>
          ))}
        </div>
        <button
          type="button"
          onClick={() => props.onSelectService(undefined)}
          disabled={props.selectedServiceId === undefined}
        >
          <RotateCcw aria-hidden="true" />
          Сбросить выбор
        </button>
      </header>
      <div className="topology-scroll">
        <ReactFlowProvider initialWidth={760} initialHeight={560} fitView>
          <TopologyCanvas {...props} />
        </ReactFlowProvider>
      </div>
    </section>
  );
}
