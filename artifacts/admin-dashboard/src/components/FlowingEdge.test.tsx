import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { Position, ReactFlowProvider } from "@xyflow/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CSSProperties } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { HealthStatus } from "../types/dashboard";
import type { ServiceEdge } from "../types/dashboard";
import {
  getSharedSourceRoutes,
  type SharedStatusBand,
} from "../lib/topology-shared-routes";
import { FlowingEdge, getEvidenceLabelWidth } from "./FlowingEdge";

afterEach(cleanup);

const dashboardCss = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");

interface RenderEdgeOptions {
  id?: string;
  status?: HealthStatus;
  motionEnabled?: boolean;
  sourceY?: number;
  targetY?: number;
  diagnostic?: {
    incidentId: string;
    code?: string;
    message: string;
  };
  style?: CSSProperties;
  sharedStatusBands?: SharedStatusBand[];
  sharedBranchLength?: number;
  renderSharedTrunk?: boolean;
  evidenceLane?: number;
}

function renderEdge({
  id = "edge-under-test",
  status = "healthy",
  motionEnabled = false,
  sourceY = 0,
  targetY = 0,
  diagnostic,
  style,
  sharedStatusBands,
  sharedBranchLength,
  renderSharedTrunk,
  evidenceLane,
}: RenderEdgeOptions = {}) {
  const data = {
    status,
    motionEnabled,
    actionable: diagnostic !== undefined,
    diagnostic,
    sharedStatusBands,
    renderSharedTrunk,
    evidenceLane,
    ...(sharedBranchLength === undefined ? {} : { sharedBranchLength }),
  };

  return render(
    <svg>
      <FlowingEdge
        id={id}
        source="source"
        target="target"
        sourceX={0}
        sourceY={sourceY}
        targetX={120}
        targetY={targetY}
        sourcePosition={Position.Right}
        targetPosition={Position.Left}
        selected={false}
        selectable={false}
        deletable={false}
        data={data}
        label="240/мин"
        style={style}
      />
    </svg>,
  );
}

function straightPathSegments(path: string) {
  const commands = Array.from(path.matchAll(/([MLQ])([^MLQ]*)/g));
  let current: { x: number; y: number } | undefined;
  return commands.flatMap(([, type, coordinates]) => {
    const values = Array.from(
      coordinates.matchAll(/-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi),
      ([value]) => Number(value),
    );
    if (type === "M") {
      current = { x: values[0]!, y: values[1]! };
      return [];
    }
    if (current === undefined) throw new Error("Expected an absolute SVG path");
    if (type === "Q") {
      current = { x: values[2]!, y: values[3]! };
      return [];
    }
    const start = current;
    const end = { x: values[0]!, y: values[1]! };
    current = end;
    return [{
      horizontal: start.y === end.y,
      fixed: start.y === end.y ? start.y : start.x,
      minimum: Math.min(
        start.y === end.y ? start.x : start.y,
        start.y === end.y ? end.x : end.y,
      ),
      maximum: Math.max(
        start.y === end.y ? start.x : start.y,
        start.y === end.y ? end.x : end.y,
      ),
    }];
  });
}

function expectRenderedSolidLanesDisjoint(container: HTMLElement) {
  const edgeSegments = Array.from(
    container.querySelectorAll<SVGPathElement>(
      ".topology-edge-status-lane:not(.topology-edge-shared-trunk)",
    ),
    (path) => straightPathSegments(path.getAttribute("d") ?? ""),
  );

  edgeSegments.forEach((leftSegments, leftIndex) => {
    edgeSegments.slice(leftIndex + 1).forEach((rightSegments) => {
      leftSegments.forEach((left) => {
        rightSegments.forEach((right) => {
          if (left.horizontal !== right.horizontal || left.fixed !== right.fixed)
            return;
          expect(
            Math.min(left.maximum, right.maximum) -
              Math.max(left.minimum, right.minimum),
          ).toBeLessThanOrEqual(0);
        });
      });
    });
  });
}

describe("FlowingEdge", () => {
  it("uses the shared visible label width formula", () => {
    expect(getEvidenceLabelWidth("WARNING SC-429")).toBe(87.60000000000001);
    expect(getEvidenceLabelWidth("NO DATA")).toBe(49.800000000000004);
  });
  it("keeps a warning conductor opaque when caller style dims the edge", () => {
    const { container } = renderEdge({
      status: "warning",
      style: { opacity: 0.28 },
    });
    const paths = container.querySelectorAll(
      ".topology-edge-conductor-base, .topology-edge-status-lane",
    );

    paths.forEach((path) => {
      expect(path).not.toHaveStyle({ opacity: "0.28" });
      expect(path.getAttribute("style")).not.toContain("stroke-dasharray");
    });
  });

  it.each([
    ["healthy", "#22c55e", 0],
    ["warning", "#f59e0b", 3],
    ["degraded", "#ef4444", 7],
  ] as const)(
    "renders %s with neutral bases and fine opaque status lanes",
    (status, color, offset) => {
      const { container } = renderEdge({ status });
      const bases = container.querySelectorAll(".topology-edge-conductor-base");
      const lanes = container.querySelectorAll(".topology-edge-status-lane");

      expect(bases).toHaveLength(2);
      bases.forEach((base) => {
        expect(base).toHaveStyle({ stroke: "#596273", strokeWidth: "1.75" });
        expect(base.getAttribute("style")).not.toContain("stroke-dasharray");
      });
      expect(lanes).toHaveLength(2);
      lanes.forEach((lane, index) => {
        expect(lane).toHaveStyle({ stroke: color, strokeWidth: "1" });
        expect(lane).toHaveAttribute("d", bases[index].getAttribute("d"));
        expect(lane.getAttribute("style")).not.toContain("stroke-dasharray");
      });
      container
        .querySelectorAll(".topology-edge-contact-rail")
        .forEach((rail) => expect(rail).toHaveStyle({ fill: color }));
      expect(
        container.querySelector(".topology-edge-contact-route-cover"),
      ).not.toBeInTheDocument();
      expect(container.querySelector(".topology-edge-contact")).toHaveAttribute(
        "data-offset",
        String(offset),
      );
    },
  );

  it.each([
    ["healthy", "connected"],
    ["warning", "unstable"],
    ["degraded", "disconnected"],
    ["unknown", "unknown"],
  ] as const)("renders %s as a %s two-part contact", (status, state) => {
    const { container, getByText } = renderEdge({ status });
    const contact = container.querySelector(".topology-edge-contact");
    const paths = container.querySelectorAll(".topology-edge-conductor");

    expect(contact).toHaveAttribute("data-state", state);
    expect(container.querySelectorAll(".topology-edge-plug-half")).toHaveLength(2);
    expect(container.querySelectorAll(".topology-edge-contact-rail")).toHaveLength(2);
    expect(container.querySelectorAll(".topology-edge-contact-notch")).toHaveLength(1);
    expect(container.querySelectorAll(".topology-edge-contact-tongue")).toHaveLength(1);
    expect(
      container.querySelector(".topology-edge-contact-female"),
    ).toHaveAttribute("data-contact-kind", "female");
    expect(
      container.querySelector(".topology-edge-contact-male"),
    ).toHaveAttribute("data-contact-kind", "male");
    expect(container.querySelector(".topology-edge-contact-female .topology-edge-contact-rail"))
      .toHaveAttribute("d", expect.stringContaining("M -16 -3"));
    expect(container.querySelector(".topology-edge-contact-male .topology-edge-contact-rail"))
      .toHaveAttribute("d", expect.stringContaining("M 16 -3"));
    expect(paths).toHaveLength(2);
    expect(paths[0]).toHaveAttribute("d", expect.stringContaining("44"));
    expect(paths[1]).toHaveAttribute("d", "M76 0 L120 0");
    expect(getByText("240/мин")).toBeInTheDocument();
  });

  it("renders every contact state as a solid interlocked coupling", () => {
    const { container } = renderEdge({ status: "degraded" });
    const rails = container.querySelectorAll(".topology-edge-contact-rail");
    const outlines = container.querySelectorAll(
      ".topology-edge-contact-outline",
    );
    const highlights = container.querySelectorAll(
      ".topology-edge-contact-highlight",
    );

    expect(rails).toHaveLength(2);
    rails.forEach((rail) => {
      expect(rail).toHaveStyle({ fill: "#ef4444" });
    });
    expect(outlines).toHaveLength(2);
    expect(highlights).toHaveLength(2);
  });

  it("paints each colored rail before its highlight and dark outline", () => {
    const { container } = renderEdge({ status: "warning" });
    const paintSelector = [
      ".topology-edge-contact-rail",
      ".topology-edge-contact-highlight",
      ".topology-edge-contact-outline",
    ].join(", ");

    container.querySelectorAll(".topology-edge-plug-half").forEach((plug) => {
      const paintOrder = Array.from(plug.querySelectorAll(paintSelector)).map(
        (paint) => paint.getAttribute("class"),
      );

      expect(paintOrder).toEqual([
        "topology-edge-contact-rail",
        "topology-edge-contact-highlight",
        "topology-edge-contact-outline",
      ]);
    });
  });

  it("uses an opaque highlight paint while preserving the currentColor glow", () => {
    const highlightRule = dashboardCss.match(
      /\.topology-edge-contact-highlight\s*{[^}]*}/s,
    )?.[0];
    const railRule = dashboardCss.match(
      /\.topology-edge-contact-rail\s*{[^}]*}/s,
    )?.[0];

    expect(highlightRule).toMatch(/stroke:\s*#[0-9a-f]{6};/i);
    expect(highlightRule).not.toMatch(/rgba?\(/i);
    expect(railRule).toMatch(
      /filter:\s*drop-shadow\([^)]*currentColor[^)]*\);/,
    );
  });

  it.each([
    {
      status: "warning" as const,
      offset: 3,
      femaleRail: "M -16 -3 H -3 V -1.15 H -9 V 1.15 H -3 V 3 H -16 Z",
      femaleSlot: "M -3 -1.15 H -9 V 1.15 H -3",
      maleRail: "M 16 -3 H 4 V -0.75 H -2 V 0.75 H 4 V 3 H 16 Z",
      maleTongue: "M -2 -0.75 H 4 V 0.75 H -2",
    },
    {
      status: "degraded" as const,
      offset: 7,
      femaleRail: "M -16 -3 H -7 V -1.15 H -13 V 1.15 H -7 V 3 H -16 Z",
      femaleSlot: "M -7 -1.15 H -13 V 1.15 H -7",
      maleRail: "M 16 -3 H 8 V -0.75 H 2 V 0.75 H 8 V 3 H 16 Z",
      maleTongue: "M 2 -0.75 H 8 V 0.75 H 2",
    },
  ])(
    "draws the $offset-unit $status contact gap with matching female and male paths",
    ({ offset, status, femaleRail, femaleSlot, maleRail, maleTongue }) => {
      const { container } = renderEdge({ status });
      const female = container.querySelector(".topology-edge-contact-female");
      const male = container.querySelector(".topology-edge-contact-male");

      expect(container.querySelector(".topology-edge-contact")).toHaveAttribute(
        "data-offset",
        String(offset),
      );
      expect(female?.querySelector(".topology-edge-contact-rail")).toHaveAttribute(
        "d",
        femaleRail,
      );
      expect(female?.querySelector(".topology-edge-contact-notch")).toHaveAttribute(
        "d",
        femaleSlot,
      );
      expect(male?.querySelector(".topology-edge-contact-rail")).toHaveAttribute(
        "d",
        maleRail,
      );
      expect(male?.querySelector(".topology-edge-contact-tongue")).toHaveAttribute(
        "d",
        maleTongue,
      );
    },
  );

  it("paints the canonical target route after an off-row contact", () => {
    const { container } = renderEdge({ sourceY: 0, targetY: 80 });
    const contact = container.querySelector(".topology-edge-contact");
    const sourcePath = container.querySelector(".topology-edge-conductor");
    const targetPath = container.querySelectorAll(".topology-edge-conductor")[1];

    expect(contact).toHaveAttribute("transform", "translate(72 80)");
    expect(sourcePath?.getAttribute("d")).toMatch(/56 80/);
    expect(targetPath).toHaveAttribute("d", "M88 80 L120 80");
  });

  it("renders one opaque gradient status lane for a shared source trunk", () => {
    const { container } = renderEdge({
      sourceY: 0,
      targetY: 80,
      sharedStatusBands: [
        { status: "healthy", count: 2 },
        { status: "warning", count: 1 },
        { status: "degraded", count: 2 },
      ],
      sharedBranchLength: 24,
      renderSharedTrunk: true,
    });
    const base = container.querySelectorAll(
      ".topology-edge-shared-trunk.topology-edge-conductor-base",
    );
    const lanes = container.querySelectorAll(
      ".topology-edge-shared-trunk.topology-edge-status-lane",
    );

    const gradient = container.querySelector("linearGradient");
    expect(base).toHaveLength(1);
    expect(base[0]).toHaveAttribute("stroke", "#596273");
    expect(base[0]).toHaveAttribute("stroke-width", "1.75");
    expect(gradient).toHaveAttribute("gradientUnits", "userSpaceOnUse");
    expect(gradient).toHaveAttribute("x1", "0");
    expect(gradient).toHaveAttribute("x2", "24");
    expect(lanes).toHaveLength(1);
    expect(lanes[0]).toHaveAttribute("d", "M 0 0 H 24");
    expect(lanes[0]).toHaveAttribute("stroke-width", "1");
    expect(lanes[0]?.getAttribute("stroke")).toMatch(/^url\(#.+\)$/);
    expect(lanes[0]).not.toHaveAttribute("transform");
    expect(gradient?.querySelectorAll("stop")).toHaveLength(6);
    expect(gradient?.querySelectorAll("stop")[0]).toHaveAttribute(
      "stop-color",
      "#22c55e",
    );
    expect(gradient?.querySelectorAll("stop")[3]).toHaveAttribute(
      "stop-color",
      "#f59e0b",
    );
    expect(gradient?.querySelectorAll("stop")[5]).toHaveAttribute(
      "stop-color",
      "#ef4444",
    );
    gradient?.querySelectorAll("stop").forEach((stop) =>
      expect(stop).toHaveAttribute("stop-opacity", "1"),
    );
  });

  it("uses distinct sanitized gradients for simultaneous shared trunks", () => {
    const sharedData = {
      status: "healthy" as const,
      motionEnabled: false,
      sharedStatusBands: [
        { status: "healthy" as const, count: 1 },
        { status: "warning" as const, count: 1 },
      ],
      sharedBranchLength: 24,
      renderSharedTrunk: true,
    };
    const { container } = render(
      <ReactFlowProvider>
        <svg>
          <FlowingEdge
            id="edge/one"
            source="source-one"
            target="target-one"
            sourceX={0}
            sourceY={0}
            targetX={120}
            targetY={0}
            sourcePosition={Position.Right}
            targetPosition={Position.Left}
            selected={false}
            selectable={false}
            deletable={false}
            data={sharedData}
            label="1/мин"
            style={{ opacity: 0.28 }}
          />
          <FlowingEdge
            id="edge:two"
            source="source-two"
            target="target-two"
            sourceX={0}
            sourceY={80}
            targetX={120}
            targetY={80}
            sourcePosition={Position.Right}
            targetPosition={Position.Left}
            selected={false}
            selectable={false}
            deletable={false}
            data={sharedData}
            label="2/мин"
            style={{ opacity: 0.28 }}
          />
        </svg>
      </ReactFlowProvider>,
    );
    const gradients = Array.from(container.querySelectorAll("linearGradient"));
    const lanes = Array.from(
      container.querySelectorAll(
        ".topology-edge-shared-trunk.topology-edge-status-lane",
      ),
    );
    const sharedPaint = Array.from(
      container.querySelectorAll(".topology-edge-shared-trunk"),
    );
    const gradientIds = gradients.map((gradient) => gradient.id);

    expect(gradients).toHaveLength(2);
    expect(new Set(gradientIds).size).toBe(2);
    gradientIds.forEach((id) => expect(id).toMatch(/^[a-zA-Z0-9_-]+$/));
    expect(lanes).toHaveLength(2);
    lanes.forEach((lane, index) => {
      expect(lane).toHaveAttribute("stroke", `url(#${gradientIds[index]})`);
      expect(lane).toHaveAttribute("stroke-width", "1");
      expect(lane).not.toHaveAttribute("transform");
      expect(lane.getAttribute("style") ?? "").not.toContain("opacity");
    });
    expect(sharedPaint.map((element) => element.getAttribute("class"))).toEqual(
      [
        "topology-edge-shared-trunk topology-edge-conductor-base",
        "topology-edge-shared-trunk topology-edge-status-lane",
        "topology-edge-shared-trunk topology-edge-conductor-base",
        "topology-edge-shared-trunk topology-edge-status-lane",
      ],
    );
    expect(
      sharedPaint.map((element) => element.getAttribute("stroke-width")),
    ).toEqual(["1.75", "1", "1.75", "1"]);
  });

  it("uses collision-proof gradient IDs for adversarial valid edge IDs", () => {
    const definitions = [
      {
        id: "core:api",
        y: 0,
        bands: [
          { status: "healthy" as const, count: 1 },
          { status: "warning" as const, count: 1 },
        ],
      },
      {
        id: "core_3a_api",
        y: 80,
        bands: [
          { status: "degraded" as const, count: 2 },
          { status: "unknown" as const, count: 1 },
        ],
      },
    ];
    const view = render(
      <svg>
        {definitions.map((definition) => (
          <FlowingEdge
            key={definition.id}
            id={definition.id}
            source={`${definition.id}-source`}
            target={`${definition.id}-target`}
            sourceX={0}
            sourceY={definition.y}
            targetX={160}
            targetY={definition.y}
            sourcePosition={Position.Right}
            targetPosition={Position.Left}
            selected={false}
            selectable={false}
            deletable={false}
            data={{
              status: definition.bands[0]!.status,
              motionEnabled: false,
              sharedStatusBands: definition.bands,
              sharedBranchLength: 24,
              renderSharedTrunk: true,
            }}
            label="1/мин"
          />
        ))}
      </svg>,
    );
    const gradients = Array.from(view.container.querySelectorAll("linearGradient"));
    const lanes = Array.from(
      view.container.querySelectorAll(
        ".topology-edge-shared-trunk.topology-edge-status-lane",
      ),
    );
    const ids = gradients.map((gradient) => gradient.id);

    expect(new Set(ids).size).toBe(definitions.length);
    expect(lanes.map((lane) => lane.getAttribute("stroke"))).toEqual(
      ids.map((id) => `url(#${id})`),
    );
    expect(
      gradients.map((gradient) =>
        Array.from(gradient.querySelectorAll("stop"), (stop) =>
          stop.getAttribute("stop-color"),
        ),
      ),
    ).toEqual([
      ["#22c55e", "#22c55e", "#f59e0b", "#f59e0b"],
      ["#ef4444", "#ef4444", "#94a3b8", "#94a3b8"],
    ]);
  });

  it("keeps unknown status paint on an individual edge", () => {
    const { container } = renderEdge({ status: "unknown" });
    const lanes = container.querySelectorAll(
      ".topology-edge-status-lane:not(.topology-edge-shared-trunk)",
    );

    expect(lanes).toHaveLength(2);
    lanes.forEach((lane) => {
      expect(lane).toHaveAttribute("stroke", "#94a3b8");
      expect(lane).toHaveAttribute("stroke-width", "1");
    });
  });

  it("uses the group branch length supplied through edge data", () => {
    const { container } = renderEdge({
      sourceY: 0,
      targetY: 80,
      sharedStatusBands: [{ status: "healthy", count: 1 }],
      sharedBranchLength: 1,
      renderSharedTrunk: true,
    });

    expect(container.querySelector(".topology-edge-conductor")).toHaveAttribute(
      "d",
      expect.stringMatching(/^M1 0/),
    );
    container.querySelectorAll(".topology-edge-shared-trunk").forEach((lane) =>
      expect(lane).toHaveAttribute("d", "M 0 0 H 1"),
    );
  });

  it("starts every grouped branch after its shared source trunk", () => {
    const { container } = renderEdge({
      sourceY: 0,
      targetY: 80,
      sharedStatusBands: [{ status: "healthy", count: 1 }],
      sharedBranchLength: 24,
    });

    expect(container.querySelector(".topology-edge-conductor")).toHaveAttribute(
      "d",
      expect.stringMatching(/^M24 0/),
    );
    expect(
      container.querySelector(".topology-edge-shared-trunk"),
    ).not.toBeInTheDocument();
  });

  it("gives default grouped branches distinct solid lanes after the shared gradient", () => {
    const sharedData = {
      motionEnabled: false,
      sharedStatusBands: [
        { status: "healthy" as const, count: 1 },
        { status: "degraded" as const, count: 1 },
        { status: "warning" as const, count: 1 },
      ],
      sharedBranchLength: 24,
    };
    const targets = [
      { id: "account", y: 62, status: "healthy" as const },
      { id: "download", y: 194, status: "degraded" as const },
      { id: "search", y: 326, status: "warning" as const },
    ];
    const { container } = render(
      <svg>
        {targets.map((target) => (
          <FlowingEdge
            key={target.id}
            id={`core-${target.id}`}
            source="core"
            target={target.id}
            sourceX={538.5}
            sourceY={194}
            targetX={665.5}
            targetY={target.y}
            sourcePosition={Position.Right}
            targetPosition={Position.Left}
            selected={false}
            selectable={false}
            deletable={false}
            data={{
              ...sharedData,
              status: target.status,
              renderSharedTrunk: target.id === "search",
            }}
            label="240/мин"
          />
        ))}
      </svg>,
    );
    const sourceLanes = Array.from(
      container.querySelectorAll(
        '.topology-edge-status-lane:not(.topology-edge-shared-trunk)',
      ),
    ).filter((lane) => lane.getAttribute("d")?.startsWith("M562.5 194"));

    expect(sourceLanes).toHaveLength(3);
    expect(sourceLanes.map((lane) => lane.getAttribute("d"))).toEqual([
      expect.stringMatching(/^M562\.5 194 L562\.5 /),
      expect.stringMatching(/^M562\.5 194 L/),
      expect.stringMatching(/^M562\.5 194 L562\.5 /),
    ]);
    expect(
      sourceLanes.filter((lane) => lane.getAttribute("d")?.includes("590.5 194")),
    ).toHaveLength(0);
    expect(
      container.querySelectorAll(
        ".topology-edge-shared-trunk.topology-edge-status-lane",
      ),
    ).toHaveLength(1);
  });

  it.each([
    {
      name: "same-direction fan-out",
      source: { x: 0, y: 180, width: 190, height: 76 },
      targets: [
        { id: "above-a", x: 380, y: -80, width: 190, height: 76 },
        { id: "above-b", x: 380, y: 20, width: 190, height: 76 },
        { id: "above-c", x: 380, y: 80, width: 190, height: 76 },
      ],
    },
    {
      name: "same-row fan-out",
      source: { x: 0, y: 100, width: 190, height: 76 },
      targets: [
        { id: "same-a", x: 380, y: 100, width: 190, height: 76 },
        { id: "same-b", x: 400, y: 100, width: 190, height: 76 },
        { id: "same-c", x: 420, y: 100, width: 190, height: 76 },
      ],
    },
    {
      name: "zero-clearance crossed fan-out",
      source: { x: 120, y: 100, width: 190, height: 76 },
      targets: [
        { id: "cross-a", x: 260, y: -20, width: 190, height: 76 },
        { id: "cross-b", x: 250, y: 20, width: 190, height: 76 },
      ],
    },
  ])("renders one gradient owner and disjoint sibling solids for $name", ({ source, targets }) => {
    const positions = new Map([
      ["source", source],
      ...targets.map((target) => [target.id, target] as const),
    ]);
    const edges: ServiceEdge[] = targets.map((target, index) => ({
      id: `source-${target.id}`,
      source: "source",
      target: target.id,
      status: index === 0 ? "warning" : "degraded",
      requestsPerMinute: 1,
    }));
    const routes = getSharedSourceRoutes([...edges].reverse(), positions);
    const { container } = render(
      <svg>
        {edges.map((candidate) => {
          const target = positions.get(candidate.target)!;
          const route = routes.get(candidate.id)!;
          return (
            <FlowingEdge
              key={candidate.id}
              id={candidate.id}
              source={candidate.source}
              target={candidate.target}
              sourceX={source.x + source.width}
              sourceY={source.y + source.height / 2}
              targetX={target.x}
              targetY={target.y + target.height / 2}
              sourcePosition={Position.Right}
              targetPosition={Position.Left}
              selected={false}
              selectable={false}
              deletable={false}
              data={{
                ...route,
                status: candidate.status,
                motionEnabled: false,
                sharedStatusBands: route.statusBands,
                renderSharedTrunk: route.renderTrunk,
              }}
              label="1/мин"
            />
          );
        })}
      </svg>,
    );

    expect(
      container.querySelectorAll(
        ".topology-edge-shared-trunk.topology-edge-status-lane",
      ),
    ).toHaveLength(1);
    expectRenderedSolidLanesDisjoint(container);
  });

  it("keeps gradient identity and semantic stops stable across reordered rerenders", () => {
    const bands = [
      { status: "healthy" as const, count: 1 },
      { status: "warning" as const, count: 1 },
    ];
    const edge = (id: string, y: number) => (
      <FlowingEdge
        key={id}
        id={id}
        source="source"
        target="target"
        sourceX={0}
        sourceY={y}
        targetX={120}
        targetY={y}
        sourcePosition={Position.Right}
        targetPosition={Position.Left}
        selected={false}
        selectable={false}
        deletable={false}
        data={{
          status: "healthy",
          motionEnabled: false,
          sharedStatusBands: bands,
          sharedBranchLength: 24,
          renderSharedTrunk: true,
        }}
        label="1/мин"
      />
    );
    const view = render(<svg>{[edge("stable-owner", 0), edge("unrelated", 80)]}</svg>);
    const readGradient = () => {
      const gradient = view.container.querySelector(
        'linearGradient[id$="stable-owner"]',
      );
      return {
        id: gradient?.id,
        stops: Array.from(gradient?.querySelectorAll("stop") ?? [], (stop) => [
          stop.getAttribute("offset"),
          stop.getAttribute("stop-color"),
          stop.getAttribute("stop-opacity"),
        ]),
      };
    };
    const initial = readGradient();

    view.rerender(<svg>{[edge("unrelated", 80), edge("stable-owner", 0)]}</svg>);

    expect(initial.id).toBe("topology-gradient-stable-owner");
    expect(readGradient()).toEqual(initial);
    expect(initial.stops.map((stop) => stop[1])).toEqual([
      "#22c55e",
      "#22c55e",
      "#f59e0b",
      "#f59e0b",
    ]);
  });

  it.each([
    { sourceY: 0, targetY: 80, evidenceLane: 0, badgeY: "-36", textY: "-29" },
    { sourceY: 0, targetY: 0, evidenceLane: 1, badgeY: "-54", textY: "-47" },
    { sourceY: 80, targetY: 0, evidenceLane: 2, badgeY: "-72", textY: "-65" },
  ])(
    "anchors status evidence above the plug in lane $evidenceLane",
    ({ sourceY, targetY, evidenceLane, badgeY, textY }) => {
      const { container } = renderEdge({
        sourceY,
        targetY,
        status: "degraded",
        evidenceLane,
      });
      const status = container.querySelector(".topology-edge-contact-status");

      expect(status).toHaveAttribute("data-evidence-lane", String(evidenceLane));
      expect(status?.querySelector("rect")).toHaveAttribute("y", badgeY);
      expect(status?.querySelector("text")).toHaveAttribute("y", textY);
      expect(container.querySelector(".topology-edge-traffic")).toHaveAttribute("y", "19");
    },
  );

  it("splits the route around the contact body without an occlusion cover", () => {
    const { container } = renderEdge();
    const paths = container.querySelectorAll(".topology-edge-conductor");

    expect(container.querySelector("mask")).not.toBeInTheDocument();
    expect(paths).toHaveLength(2);
    expect(paths[0].getAttribute("d")).toMatch(/L44 0$/);
    expect(paths[1]).toHaveAttribute("d", "M76 0 L120 0");
  });

  it("keeps the plug body thicker than its route and status lane", () => {
    const { container } = renderEdge();
    const bases = container.querySelectorAll(".topology-edge-conductor-base");
    const lanes = container.querySelectorAll(".topology-edge-status-lane");
    const rails = container.querySelectorAll(".topology-edge-contact-rail");

    bases.forEach((base) => expect(base).toHaveStyle({ strokeWidth: "1.75" }));
    lanes.forEach((lane) => expect(lane).toHaveStyle({ strokeWidth: "1" }));
    rails.forEach((rail) => {
      expect(rail).toHaveAttribute("d", expect.stringContaining("-3"));
      expect(rail).toHaveAttribute("d", expect.stringContaining("3"));
      expect(rail).toHaveAttribute("stroke-width", "0");
    });
  });

  it("keeps conductors, shared lanes, and contacts opaque when caller style dims the edge", () => {
    const { container } = renderEdge({
      status: "degraded",
      style: { opacity: 0.28 },
      sharedStatusBands: [{ status: "healthy", count: 1 }],
      sharedBranchLength: 24,
      renderSharedTrunk: true,
    });
    const painted = container.querySelectorAll<SVGElement>(
      ".topology-edge-conductor-base, .topology-edge-status-lane, .topology-edge-contact, .topology-edge-plug-half",
    );

    painted.forEach((element) => {
      expect(element).not.toHaveStyle({ opacity: "0.28" });
      expect(element.getAttribute("style") ?? "").not.toContain("opacity");
    });
  });

  it("shows warning evidence and flicker only while motion is enabled", () => {
    const diagnostic = {
      incidentId: "incident-warning",
      code: "SC-429",
      message: "Провайдер ограничивает запросы",
    };
    const animated = renderEdge({
      status: "warning",
      motionEnabled: true,
      diagnostic,
    });

    expect(animated.getByText("WARNING SC-429")).toBeInTheDocument();
    expect(
      animated.container.querySelector(".topology-edge-warning-spark"),
    ).toBeInTheDocument();
    animated.unmount();

    const reduced = renderEdge({
      status: "warning",
      motionEnabled: false,
      diagnostic,
    });
    expect(
      reduced.container.querySelector(".topology-edge-warning-spark"),
    ).not.toBeInTheDocument();
    expect(reduced.getByText("WARNING SC-429")).toBeInTheDocument();
  });

  it("exposes journal action copy without nesting an interactive SVG control", () => {
    const { container } = renderEdge({
      status: "degraded",
      diagnostic: {
        incidentId: "incident-download-errors",
        code: "DLW-E502",
        message: "Соединение с хранилищем прервано",
      },
    });

    expect(container.querySelector(".topology-edge-contact")).toHaveAttribute(
      "aria-label",
      "Соединение разорвано, ошибка DLW-E502. Открыть журнал",
    );
    expect(container.querySelector(".topology-edge-contact")).toHaveAttribute(
      "role",
      "presentation",
    );
  });

  it("shows a generic error without inventing a missing diagnostic code", () => {
    const { container, getByText } = renderEdge({
      status: "degraded",
      diagnostic: {
        incidentId: "incident-without-code",
        message: "Контакт потерян",
      },
    });

    expect(getByText("ERROR")).toBeInTheDocument();
    expect(
      container.querySelector(".topology-edge-contact"),
    ).toHaveAttribute("aria-label", "Соединение разорвано. Открыть журнал");
  });

  it("truncates a long visible status code while preserving it in accessible copy", () => {
    const code = "X".repeat(64);
    const { container, getByText } = renderEdge({
      status: "degraded",
      diagnostic: {
        incidentId: "incident-long-code",
        code,
        message: "Контакт потерян",
      },
    });

    expect(getByText(`ERROR ${"X".repeat(9)}...`)).toBeInTheDocument();
    expect(container.querySelector(".topology-edge-contact")).toHaveAttribute(
      "aria-label",
      `Соединение разорвано, ошибка ${code}. Открыть журнал`,
    );
  });
});
