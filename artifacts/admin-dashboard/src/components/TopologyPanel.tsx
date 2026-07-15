import {
  Background,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type EdgeTypes,
  type NodeChange,
  type NodeTypes,
} from "@xyflow/react";
import { Maximize2, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import { useReducedMotion } from "framer-motion";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { getServiceNeighborhood } from "../lib/dashboard-model";
import { layoutTopology } from "../lib/topology-layout";
import type {
  DashboardSnapshot,
  HealthStatus,
  ServiceEdge,
} from "../types/dashboard";
import {
  FlowingEdge,
  getEdgeAccessibleLabel,
  type TopologyFlowEdge,
} from "./FlowingEdge";
import { ServiceNode, type ServiceFlowNode } from "./ServiceNode";

const nodeTypes: NodeTypes = { service: ServiceNode };
const edgeTypes: EdgeTypes = { flowing: FlowingEdge };
const statusLabels: Record<HealthStatus, string> = {
  healthy: "Работает",
  warning: "Предупреждение",
  degraded: "Деградация",
  unknown: "Нет данных",
};

const statusOrder: HealthStatus[] = [
  "healthy",
  "warning",
  "degraded",
  "unknown",
];

export interface SharedSourceRoute {
  statuses: HealthStatus[];
  renderTrunk: boolean;
}

export function getSharedSourceRoutes(
  edges: ServiceEdge[],
): Map<string, SharedSourceRoute> {
  const edgesBySource = new Map<string, ServiceEdge[]>();
  edges.forEach((edge) => {
    const sourceEdges = edgesBySource.get(edge.source) ?? [];
    sourceEdges.push(edge);
    edgesBySource.set(edge.source, sourceEdges);
  });

  const routes = new Map<string, SharedSourceRoute>();
  edgesBySource.forEach((sourceEdges) => {
    if (sourceEdges.length < 2) return;
    const statuses = statusOrder.filter((status) =>
      sourceEdges.some((edge) => edge.status === status),
    );
    sourceEdges.forEach((edge, index) => {
      routes.set(edge.id, {
        statuses,
        renderTrunk: index === sourceEdges.length - 1,
      });
    });
  });
  return routes;
}

function getTerminalStatuses(edges: ServiceEdge[]) {
  const byService = new Map<
    string,
    { source: Set<HealthStatus>; target: Set<HealthStatus> }
  >();
  const getEntry = (serviceId: string) => {
    const existing = byService.get(serviceId);
    if (existing !== undefined) return existing;
    const entry = { source: new Set<HealthStatus>(), target: new Set<HealthStatus>() };
    byService.set(serviceId, entry);
    return entry;
  };

  edges.forEach((edge) => {
    getEntry(edge.source).source.add(edge.status);
    getEntry(edge.target).target.add(edge.status);
  });

  return new Map(
    Array.from(byService, ([serviceId, statuses]) => [
      serviceId,
      {
        sourceStatuses: statusOrder.filter((status) => statuses.source.has(status)),
        targetStatuses: statusOrder.filter((status) => statuses.target.has(status)),
      },
    ]),
  );
}

export function formatTrafficLabel(requestsPerMinute: number): string {
  return `${requestsPerMinute}/мин`;
}

export function isDashboardMotionEnabled(
  documentVisible: boolean,
  reducedMotion: boolean,
): boolean {
  return documentVisible && !reducedMotion;
}

interface TopologyPanelProps {
  snapshot: DashboardSnapshot;
  selectedServiceId?: string;
  neighborhood?: Set<string>;
  onSelectService: (serviceId?: string) => void;
  onOpenIncident?: (incidentId: string) => void;
}

interface TopologyCanvasProps extends TopologyPanelProps {
  scrollContainerRef: RefObject<HTMLDivElement | null>;
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
  onOpenIncident,
  scrollContainerRef,
}: TopologyCanvasProps) {
  const reducedMotion = useReducedMotion() ?? false;
  const documentVisible = useDocumentVisible();
  const { getNode, getZoom, setCenter } = useReactFlow();
  const motionEnabled = isDashboardMotionEnabled(
    documentVisible,
    reducedMotion,
  );
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
  const incidentsById = useMemo(
    () => new Map(snapshot.incidents.map((incident) => [incident.id, incident])),
    [snapshot.incidents],
  );
  const sharedSourceRoutes = useMemo(
    () => getSharedSourceRoutes(snapshot.edges),
    [snapshot.edges],
  );
  const terminalStatuses = useMemo(
    () => getTerminalStatuses(snapshot.edges),
    [snapshot.edges],
  );
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
        ariaLabel: module.name,
        style: {
          opacity:
            activeNeighborhood !== undefined &&
            !activeNeighborhood.has(module.id)
              ? 0.28
              : 1,
        },
        data: {
          module,
          motionEnabled,
          sourceStatuses:
            terminalStatuses.get(module.id)?.sourceStatuses ?? [module.status],
          targetStatuses:
            terminalStatuses.get(module.id)?.targetStatuses ?? [module.status],
        },
      };
    });
  }, [
    activeNeighborhood,
    layout.nodes,
    motionEnabled,
    selectedServiceId,
    snapshot.modules,
    terminalStatuses,
  ]);
  const edges = useMemo<TopologyFlowEdge[]>(
    () =>
      snapshot.edges.map((edge) => {
        const incident =
          edge.incidentId === undefined
            ? undefined
            : incidentsById.get(edge.incidentId);
        const linkedIncident =
          incident?.diagnostic !== undefined &&
          (edge.status === "warning" || edge.status === "degraded") &&
          (incident.serviceId === edge.source || incident.serviceId === edge.target)
            ? incident
            : undefined;
        const canOpenIncident =
          linkedIncident !== undefined && onOpenIncident !== undefined;
        return {
          id: edge.id,
          type: "flowing",
          source: edge.source,
          target: edge.target,
          focusable: canOpenIncident,
          ariaRole: canOpenIncident ? "button" : "img",
          ariaLabel: getEdgeAccessibleLabel(
            edge.status,
            linkedIncident?.diagnostic?.code,
            canOpenIncident,
          ),
          domAttributes:
            !canOpenIncident || linkedIncident === undefined
              ? undefined
              : {
                  onKeyDown: (event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    onOpenIncident(linkedIncident.id);
                  },
                },
          label: formatTrafficLabel(edge.requestsPerMinute),
          data: {
            status: edge.status,
            diagnostic:
              linkedIncident?.diagnostic === undefined
                ? undefined
                : {
                    incidentId: linkedIncident.id,
                    code: linkedIncident.diagnostic.code,
                    message: linkedIncident.diagnostic.message,
                  },
            actionable: canOpenIncident,
            sharedStatuses: sharedSourceRoutes.get(edge.id)?.statuses,
            renderSharedTrunk: sharedSourceRoutes.get(edge.id)?.renderTrunk,
            motionEnabled:
              edge.requestsPerMinute > 0 &&
              motionEnabled &&
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
        };
      }),
    [
      incidentsById,
      motionEnabled,
      onOpenIncident,
      selectedServiceId,
      sharedSourceRoutes,
      snapshot.edges,
    ],
  );

  useEffect(() => {
    if (selectedServiceId === undefined) return;
    const selectedNode = getNode(selectedServiceId);
    if (selectedNode === undefined) return;
    const position = selectedNode.position;
    const width =
      selectedNode.measured?.width ?? selectedNode.width ?? 190;
    const height =
      selectedNode.measured?.height ?? selectedNode.height ?? 76;

    void setCenter(position.x + width / 2, position.y + height / 2, {
      duration: reducedMotion ? 0 : 240,
      zoom: getZoom(),
    });

    const scrollContainer = scrollContainerRef.current;
    if (
      scrollContainer !== null &&
      scrollContainer.scrollWidth > scrollContainer.clientWidth
    ) {
      // setCenter places the node at the canvas midpoint; reveal that midpoint externally.
      scrollContainer.scrollTo?.({
        behavior: reducedMotion ? "auto" : "smooth",
        left:
          (scrollContainer.scrollWidth - scrollContainer.clientWidth) / 2,
        top: 0,
      });
    }
  }, [
    getNode,
    getZoom,
    reducedMotion,
    scrollContainerRef,
    selectedServiceId,
    setCenter,
  ]);

  const handleNodesChange = useCallback(
    (changes: NodeChange<ServiceFlowNode>[]) => {
      const selectedChange = changes.find(
        (change) => change.type === "select" && change.selected,
      );
      if (selectedChange?.type === "select") {
        if (selectedChange.id !== selectedServiceId)
          onSelectService(selectedChange.id);
        return;
      }

      const currentSelectionCleared = changes.some(
        (change) =>
          change.type === "select" &&
          !change.selected &&
          change.id === selectedServiceId,
      );
      if (currentSelectionCleared) onSelectService(undefined);
    },
    [onSelectService, selectedServiceId],
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
        nodesFocusable
        onNodeClick={(_, node) => onSelectService(node.id)}
        onEdgeClick={(_, edge) => {
          const incidentId = edge.data?.diagnostic?.incidentId;
          if (incidentId !== undefined) onOpenIncident?.(incidentId);
        }}
        onNodesChange={handleNodesChange}
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
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  return (
    <section className="topology-panel" id="topology" aria-label="Топология сервисов">
      <div className="topology-panel-header">
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
      </div>
      <div className="topology-scroll" ref={scrollContainerRef}>
        <ReactFlowProvider initialWidth={760} initialHeight={560} fitView>
          <TopologyCanvas
            {...props}
            scrollContainerRef={scrollContainerRef}
          />
        </ReactFlowProvider>
      </div>
    </section>
  );
}
