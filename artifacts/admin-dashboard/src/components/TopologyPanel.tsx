import {
  Background,
  Position,
  ReactFlow,
  ReactFlowProvider,
  ViewportPortal,
  useReactFlow,
  type EdgeTypes,
  type NodeChange,
  type NodeTypes,
  type XYPosition,
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
import { buildConnectorGeometry } from "../lib/topology-connector-geometry";
import { getSharedSourceRoutes } from "../lib/topology-shared-routes";
import {
  assignEvidenceLabelLanes,
  getConnectorVisualRects,
  getEvidenceLabelRect,
  getTopologyVisualBounds,
  type EvidenceAnchor,
} from "../lib/topology-evidence-layout";
import {
  applyPositionChanges,
  prunePositionOverrides,
} from "../lib/topology-position-overrides";
import {
  alignTopologyPosition,
  moveTopologyPositionByKeyboard,
  TOPOLOGY_GRID_SIZE,
  type AlignmentGuide,
  type TopologyAlignmentMode,
} from "../lib/topology-alignment";
import type {
  DashboardSnapshot,
  HealthStatus,
  ServiceEdge,
} from "../types/dashboard";
import {
  FlowingEdge,
  getEdgeAccessibleLabel,
  getEvidenceLabelText,
  getEvidenceLabelWidth,
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
const alignmentModes = ["free", "align"] as const;
const EVIDENCE_LABEL_HEIGHT = 14;
const EVIDENCE_LABEL_BASE_OFFSET = 22;
const EVIDENCE_LABEL_LANE_GAP = 4;

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
  alignmentMode: TopologyAlignmentMode;
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

interface ViewportControlsProps {
  reducedMotion: boolean;
  hasPositionOverrides: boolean;
  topologyVisualBounds: ReturnType<typeof getTopologyVisualBounds>;
  onResetLayout: () => void;
}

function ViewportControls({
  reducedMotion,
  hasPositionOverrides,
  topologyVisualBounds,
  onResetLayout,
}: ViewportControlsProps) {
  const { fitBounds, zoomIn, zoomOut } = useReactFlow();
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
        onClick={() => {
          if (topologyVisualBounds !== undefined)
            void fitBounds(topologyVisualBounds, { duration, padding: 0.12 });
        }}
      >
        <Maximize2 aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label="Сбросить раскладку"
        title="Сбросить раскладку"
        disabled={!hasPositionOverrides}
        onClick={onResetLayout}
      >
        <RotateCcw aria-hidden="true" />
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
  alignmentMode,
}: TopologyCanvasProps) {
  const reducedMotion = useReducedMotion() ?? false;
  const documentVisible = useDocumentVisible();
  const { fitBounds, getNode, getZoom, setCenter } = useReactFlow();
  const didInitialFit = useRef(false);
  const freelyMovedNodeIds = useRef(new Set<string>());
  const motionEnabled = isDashboardMotionEnabled(
    documentVisible,
    reducedMotion,
  );
  const [positionOverrides, setPositionOverrides] = useState<
    Map<string, XYPosition>
  >(() => new Map());
  const [alignmentGuides, setAlignmentGuides] = useState<AlignmentGuide[]>([]);
  const layout = useMemo(
    () => layoutTopology(snapshot.modules, snapshot.edges),
    [snapshot.edges, snapshot.modules],
  );
  const moduleIds = useMemo(
    () => new Set(snapshot.modules.map((module) => module.id)),
    [snapshot.modules],
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
  const currentNodePositions = useMemo(() => {
    const dagrePositions = new Map(layout.nodes.map((node) => [node.id, node]));

    return new Map(
      snapshot.modules.map((module) => {
        const dagrePosition = dagrePositions.get(module.id);
        if (dagrePosition === undefined)
          throw new Error(`Не найдена позиция сервиса ${module.id}`);
        const override = positionOverrides.get(module.id);
        return [
          module.id,
          {
            ...dagrePosition,
            x: override?.x ?? dagrePosition.x,
            y: override?.y ?? dagrePosition.y,
          },
        ];
      }),
    );
  }, [layout.nodes, positionOverrides, snapshot.modules]);
  const sharedSourceRoutes = useMemo(
    () => getSharedSourceRoutes(snapshot.edges, currentNodePositions),
    [currentNodePositions, snapshot.edges],
  );
  const terminalStatuses = useMemo(
    () => getTerminalStatuses(snapshot.edges),
    [snapshot.edges],
  );
  const connectorGeometries = useMemo(() => {
    const geometries = new Map<
      string,
      ReturnType<typeof buildConnectorGeometry>
    >();
    snapshot.edges.forEach((edge) => {
      const source = currentNodePositions.get(edge.source);
      const target = currentNodePositions.get(edge.target);
      if (source === undefined || target === undefined) return;
      geometries.set(
        edge.id,
        buildConnectorGeometry({
          sourceX: source.x + source.width,
          sourceY: source.y + source.height / 2,
          sourcePosition: Position.Right,
          targetX: target.x,
          targetY: target.y + target.height / 2,
          targetPosition: Position.Left,
          sharedBranchLength:
            sharedSourceRoutes.get(edge.id)?.sharedBranchLength,
        }),
      );
    });
    return geometries;
  }, [currentNodePositions, sharedSourceRoutes, snapshot.edges]);
  const evidenceLayout = useMemo(() => {
    const moduleRects = Array.from(currentNodePositions.values(), (node) => ({
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
    }));
    const anchors: EvidenceAnchor[] = [];

    snapshot.edges.forEach((edge) => {
      if (edge.status === "healthy") return;
      const geometry = connectorGeometries.get(edge.id);
      if (geometry === undefined) return;
      const incident =
        edge.incidentId === undefined ? undefined : incidentsById.get(edge.incidentId);
      const diagnosticCode =
        incident?.diagnostic !== undefined &&
        (edge.status === "warning" || edge.status === "degraded") &&
        (incident.serviceId === edge.source || incident.serviceId === edge.target)
          ? incident.diagnostic.code
          : undefined;
      const statusText = getEvidenceLabelText(edge.status, diagnosticCode);
      if (statusText === undefined) return;
      anchors.push({
        id: edge.id,
        x: geometry.contactX,
        y: geometry.contactY,
        width: getEvidenceLabelWidth(statusText),
      });
    });

    const lanes = assignEvidenceLabelLanes({
      anchors,
      obstacles: moduleRects,
      labelHeight: EVIDENCE_LABEL_HEIGHT,
      baseOffset: EVIDENCE_LABEL_BASE_OFFSET,
      laneGap: EVIDENCE_LABEL_LANE_GAP,
    });
    const labelRects = anchors.map((anchor) =>
      getEvidenceLabelRect(anchor, lanes.get(anchor.id) ?? 0, {
        labelHeight: EVIDENCE_LABEL_HEIGHT,
        baseOffset: EVIDENCE_LABEL_BASE_OFFSET,
        laneGap: EVIDENCE_LABEL_LANE_GAP,
      }),
    );
    const connectorRects = snapshot.edges.flatMap((edge) => {
      const geometry = connectorGeometries.get(edge.id);
      return geometry === undefined
        ? []
        : getConnectorVisualRects(
            geometry,
            formatTrafficLabel(edge.requestsPerMinute),
          );
    });
    return {
      lanes,
      topologyVisualBounds: getTopologyVisualBounds(
        moduleRects,
        connectorRects,
        labelRects,
      ),
    };
  }, [connectorGeometries, currentNodePositions, incidentsById, snapshot.edges]);

  useEffect(() => {
    setPositionOverrides((overrides) =>
      prunePositionOverrides(overrides, moduleIds),
    );
  }, [moduleIds]);

  useEffect(() => {
    setAlignmentGuides([]);
  }, [alignmentMode]);

  const nodes = useMemo<ServiceFlowNode[]>(() => {
    return snapshot.modules.map((module) => {
      const position = currentNodePositions.get(module.id);
      if (position === undefined)
        throw new Error(`Не найдена позиция сервиса ${module.id}`);
      return {
        id: module.id,
        type: "service",
        position: { x: position.x, y: position.y },
        width: position.width,
        height: position.height,
        measured: {
          width: position.width,
          height: position.height,
        },
        selected: module.id === selectedServiceId,
        draggable: true,
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
    currentNodePositions,
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
            sharedStatusBands: sharedSourceRoutes.get(edge.id)?.statusBands,
            sharedBranchLength:
              sharedSourceRoutes.get(edge.id)?.sharedBranchLength,
            renderSharedTrunk: sharedSourceRoutes.get(edge.id)?.renderTrunk,
            ...(edge.status === "healthy"
              ? {}
              : { evidenceLane: evidenceLayout.lanes.get(edge.id) }),
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
      evidenceLayout.lanes,
      sharedSourceRoutes,
      snapshot.edges,
    ],
  );

  useEffect(() => {
    if (didInitialFit.current || evidenceLayout.topologyVisualBounds === undefined)
      return;
    didInitialFit.current = true;
    void fitBounds(evidenceLayout.topologyVisualBounds, {
      duration: reducedMotion ? 0 : 160,
      padding: 0.12,
    });
  }, [evidenceLayout.topologyVisualBounds, fitBounds, reducedMotion]);

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
      changes.forEach((change) => {
        if (change.type !== "position" || change.position === undefined) return;
        if (alignmentMode === "free") freelyMovedNodeIds.current.add(change.id);
        else freelyMovedNodeIds.current.delete(change.id);
      });
      const normalizedChanges = changes.map((change) => {
        if (change.type !== "position" || change.position === undefined)
          return change;
        const moving = currentNodePositions.get(change.id);
        if (moving === undefined) return change;
        const aligned = alignTopologyPosition({
          nodeId: change.id,
          position: change.position,
          width: moving.width,
          height: moving.height,
          nodes: Array.from(currentNodePositions, ([id, node]) => ({
            id,
            position: { x: node.x, y: node.y },
            width: node.width,
            height: node.height,
          })),
          zoom: getZoom(),
          mode: alignmentMode,
          precision: false,
        });
        if (change.dragging === true) setAlignmentGuides(aligned.guides);
        else setAlignmentGuides([]);
        return { ...change, position: aligned.position };
      });
      setPositionOverrides((overrides) =>
        applyPositionChanges(overrides, normalizedChanges),
      );

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
    [alignmentMode, currentNodePositions, getZoom, onSelectService, selectedServiceId],
  );

  const handleKeyDownCapture = useCallback(
    (event: React.KeyboardEvent) => {
      if (
        alignmentMode !== "align" ||
        !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) ||
        !(event.target instanceof Element)
      )
        return;
      const nodeElement = event.target.closest<HTMLElement>(
        ".react-flow__node[data-id]",
      );
      const nodeId = nodeElement?.dataset.id;
      if (nodeId === undefined) return;
      const moving = currentNodePositions.get(nodeId);
      if (moving === undefined) return;

      event.preventDefault();
      event.stopPropagation();
      const precision = event.altKey;
      const moved = moveTopologyPositionByKeyboard({
        key: event.key as "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown",
        position: { x: moving.x, y: moving.y },
        zoom: getZoom(),
        precision,
      });
      const preserveGeneratedPhase = !freelyMovedNodeIds.current.has(nodeId);
      const gridPhase = preserveGeneratedPhase
        ? {
            x: moving.x % TOPOLOGY_GRID_SIZE,
            y: moving.y % TOPOLOGY_GRID_SIZE,
          }
        : { x: 0, y: 0 };
      const aligned = alignTopologyPosition({
        nodeId,
        position: {
          x: moved.x - gridPhase.x,
          y: moved.y - gridPhase.y,
        },
        width: moving.width,
        height: moving.height,
        nodes: Array.from(currentNodePositions, ([id, node]) => ({
          id,
          position: {
            x: node.x - gridPhase.x,
            y: node.y - gridPhase.y,
          },
          width: node.width,
          height: node.height,
        })),
        zoom: getZoom(),
        mode: alignmentMode,
        precision: false,
      });
      const position = precision
        ? moved
        : {
            x: aligned.position.x + gridPhase.x,
            y: aligned.position.y + gridPhase.y,
          };
      if (!precision) freelyMovedNodeIds.current.delete(nodeId);
      setAlignmentGuides([]);
      setPositionOverrides((overrides) =>
        applyPositionChanges(overrides, [
          { type: "position", id: nodeId, position },
        ]),
      );
    },
    [alignmentMode, currentNodePositions, getZoom],
  );

  return (
    <div className="topology-canvas" onKeyDownCapture={handleKeyDownCapture}>
      <ReactFlow<ServiceFlowNode, TopologyFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        minZoom={0.45}
        maxZoom={1.6}
        nodesDraggable
        nodesConnectable={false}
        nodesFocusable
        snapToGrid={alignmentMode === "align"}
        snapGrid={[TOPOLOGY_GRID_SIZE, TOPOLOGY_GRID_SIZE]}
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
        <ViewportPortal>
          {alignmentGuides.map((guide) => (
            <span
              key={`${guide.axis}:${guide.position}`}
              className={`topology-alignment-guide topology-alignment-guide--${guide.axis}`}
              data-alignment-axis={guide.axis}
              style={
                guide.axis === "x"
                  ? { left: guide.position }
                  : { top: guide.position }
              }
              aria-hidden="true"
            />
          ))}
        </ViewportPortal>
        <ViewportControls
          reducedMotion={reducedMotion}
          hasPositionOverrides={positionOverrides.size > 0}
          topologyVisualBounds={evidenceLayout.topologyVisualBounds}
          onResetLayout={() => {
            setPositionOverrides(new Map());
            setAlignmentGuides([]);
            freelyMovedNodeIds.current.clear();
          }}
        />
      </ReactFlow>
    </div>
  );
}

export function TopologyPanel(props: TopologyPanelProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [alignmentMode, setAlignmentMode] =
    useState<TopologyAlignmentMode>("align");

  const handleAlignmentModeKeyDown = useCallback(
    (
      event: React.KeyboardEvent<HTMLButtonElement>,
      mode: TopologyAlignmentMode,
    ) => {
      const currentIndex = alignmentModes.indexOf(mode);
      let nextIndex: number;

      switch (event.key) {
        case "ArrowLeft":
        case "ArrowUp":
          nextIndex =
            (currentIndex - 1 + alignmentModes.length) % alignmentModes.length;
          break;
        case "ArrowRight":
        case "ArrowDown":
          nextIndex = (currentIndex + 1) % alignmentModes.length;
          break;
        default:
          return;
      }

      event.preventDefault();
      event.stopPropagation();
      const nextMode = alignmentModes[nextIndex];
      setAlignmentMode(nextMode);
      event.currentTarget.parentElement
        ?.querySelector<HTMLButtonElement>(`[data-alignment-mode="${nextMode}"]`)
        ?.focus();
    },
    [],
  );

  return (
    <section className="topology-panel" id="topology" aria-label="Топология сервисов">
      <div className="topology-panel-header">
        <h2>Топология сервисов</h2>
        <div
          className="topology-alignment-mode"
          role="radiogroup"
          aria-label="Режим размещения"
        >
          {alignmentModes.map((mode) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={alignmentMode === mode}
              tabIndex={alignmentMode === mode ? 0 : -1}
              data-alignment-mode={mode}
              onClick={() => setAlignmentMode(mode)}
              onKeyDown={(event) => handleAlignmentModeKeyDown(event, mode)}
            >
              {mode === "free" ? "Свободно" : "Выровнять"}
            </button>
          ))}
        </div>
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
        <ReactFlowProvider initialWidth={760} initialHeight={560}>
          <TopologyCanvas
            {...props}
            scrollContainerRef={scrollContainerRef}
            alignmentMode={alignmentMode}
          />
        </ReactFlowProvider>
      </div>
    </section>
  );
}
