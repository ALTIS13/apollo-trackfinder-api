import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { Position } from "@xyflow/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CSSProperties } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { HealthStatus } from "../types/dashboard";
import { FlowingEdge } from "./FlowingEdge";

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
  sharedStatuses?: HealthStatus[];
  sharedBranchLength?: number;
  renderSharedTrunk?: boolean;
}

function renderEdge({
  id = "edge-under-test",
  status = "healthy",
  motionEnabled = false,
  sourceY = 0,
  targetY = 0,
  diagnostic,
  style,
  sharedStatuses,
  sharedBranchLength,
  renderSharedTrunk,
}: RenderEdgeOptions = {}) {
  const data = {
    status,
    motionEnabled,
    actionable: diagnostic !== undefined,
    diagnostic,
    sharedStatuses,
    renderSharedTrunk,
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

describe("FlowingEdge", () => {
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
    expect(paths[1]).toHaveAttribute("d", "M 108 0 H 120");
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

  it("keeps both outer contact ends on the final horizontal segment of a bent edge", () => {
    const { container } = renderEdge({ sourceY: 0, targetY: 80 });
    const contact = container.querySelector(".topology-edge-contact");
    const sourcePath = container.querySelector(".topology-edge-conductor");
    const targetStub = container.querySelectorAll(".topology-edge-conductor")[1];

    expect(contact).toHaveAttribute("transform", "translate(92 80)");
    expect(sourcePath?.getAttribute("d")).toMatch(/L76 80$/);
    expect(targetStub).toHaveAttribute("d", "M 108 80 H 120");
  });

  it("renders an opaque shared source trunk once with fixed status lanes", () => {
    const { container } = renderEdge({
      sourceY: 0,
      targetY: 80,
      sharedStatuses: [
        "unknown",
        "degraded",
        "healthy",
        "warning",
        "degraded",
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

    expect(container.querySelector("linearGradient")).not.toBeInTheDocument();
    expect(base).toHaveLength(1);
    expect(base[0]).toHaveAttribute("stroke", "#596273");
    expect(base[0]).toHaveAttribute("stroke-width", "1.75");
    expect(lanes).toHaveLength(3);
    lanes.forEach((lane) => {
      expect(lane).toHaveAttribute("d", "M 0 0 H 24");
      expect(lane).not.toHaveAttribute("stroke-dasharray");
      expect(lane).toHaveAttribute("stroke-width", "1");
    });
    expect(lanes[0]).toHaveAttribute("stroke", "#22c55e");
    expect(lanes[0]).toHaveAttribute("transform", "translate(0 -1)");
    expect(lanes[1]).toHaveAttribute("stroke", "#f59e0b");
    expect(lanes[1]).toHaveAttribute("transform", "translate(0 0)");
    expect(lanes[2]).toHaveAttribute("stroke", "#ef4444");
    expect(lanes[2]).toHaveAttribute("transform", "translate(0 1)");
    expect(
      container.querySelector(
        '.topology-edge-shared-trunk[stroke="#94a3b8"]',
      ),
    ).not.toBeInTheDocument();
  });

  it.each([
    [["healthy"], [["#22c55e", "translate(0 -1)"]]],
    [["warning"], [["#f59e0b", "translate(0 0)"]]],
    [["degraded"], [["#ef4444", "translate(0 1)"]]],
    [
      ["healthy", "degraded"],
      [
        ["#22c55e", "translate(0 -1)"],
        ["#ef4444", "translate(0 1)"],
      ],
    ],
  ] as const)(
    "keeps fixed shared lane offsets for the active subset %#",
    (sharedStatuses, expectedLanes) => {
      const { container } = renderEdge({
        sharedStatuses: [...sharedStatuses],
        sharedBranchLength: 24,
        renderSharedTrunk: true,
      });
      const lanes = container.querySelectorAll(
        ".topology-edge-shared-trunk.topology-edge-status-lane",
      );

      expect(lanes).toHaveLength(expectedLanes.length);
      expectedLanes.forEach(([stroke, transform], index) => {
        expect(lanes[index]).toHaveAttribute("stroke", stroke);
        expect(lanes[index]).toHaveAttribute("transform", transform);
      });
    },
  );

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
      sharedStatuses: ["healthy", "warning", "degraded"],
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
      sharedStatuses: ["healthy", "warning", "degraded"],
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

  it.each([
    { sourceY: 0, targetY: 80, badgeY: "-58", textY: "-51" },
    { sourceY: 0, targetY: 0, badgeY: "-58", textY: "-51" },
    { sourceY: 80, targetY: 0, badgeY: "44", textY: "51" },
  ])(
    "places status evidence in the free row channel for $sourceY -> $targetY",
    ({ sourceY, targetY, badgeY, textY }) => {
      const { container } = renderEdge({
        sourceY,
        targetY,
        status: "degraded",
      });
      const status = container.querySelector(".topology-edge-contact-status");

      expect(status?.querySelector("rect")).toHaveAttribute("y", badgeY);
      expect(status?.querySelector("text")).toHaveAttribute("y", textY);
    },
  );

  it("splits the route around the contact body without an occlusion cover", () => {
    const { container } = renderEdge();
    const paths = container.querySelectorAll(".topology-edge-conductor");

    expect(container.querySelector("mask")).not.toBeInTheDocument();
    expect(paths).toHaveLength(2);
    expect(paths[0].getAttribute("d")).toMatch(/L76 0$/);
    expect(paths[1]).toHaveAttribute("d", "M 108 0 H 120");
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
      sharedStatuses: ["healthy", "warning", "degraded"],
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
