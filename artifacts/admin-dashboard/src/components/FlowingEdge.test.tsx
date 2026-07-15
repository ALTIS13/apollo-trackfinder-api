import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { Position } from "@xyflow/react";
import type { CSSProperties } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { HealthStatus } from "../types/dashboard";
import { FlowingEdge } from "./FlowingEdge";

afterEach(cleanup);

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
  renderSharedTrunk,
}: RenderEdgeOptions = {}) {
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
        data={{
          status,
          motionEnabled,
          actionable: diagnostic !== undefined,
          diagnostic,
          sharedStatuses,
          renderSharedTrunk,
        }}
        label="240/мин"
        style={style}
      />
    </svg>,
  );
}

describe("FlowingEdge", () => {
  it("merges caller style into the warning conductor", () => {
    const { container } = renderEdge({
      status: "warning",
      style: { opacity: 0.28 },
    });
    const path = container.querySelector(".topology-edge-conductor");

    expect(path).toHaveStyle({ opacity: "0.28" });
    expect(path?.getAttribute("style")).not.toContain("stroke-dasharray");
  });

  it.each([
    ["healthy", "#22c55e", 0],
    ["warning", "#f59e0b", 3],
    ["degraded", "#ef4444", 7],
  ] as const)("renders %s as an opaque conductor", (status, color, offset) => {
    const { container } = renderEdge({ status });
    const segments = container.querySelectorAll(".topology-edge-conductor");

    expect(segments).toHaveLength(2);
    segments.forEach((segment) => {
      expect(segment).toHaveStyle({ stroke: color, strokeWidth: "6" });
      expect(segment.getAttribute("style")).not.toContain("stroke-dasharray");
    });
    container.querySelectorAll(".topology-edge-contact-rail").forEach((rail) =>
      expect(rail).toHaveStyle({ fill: color }),
    );
    expect(
      container.querySelector(".topology-edge-contact-route-cover"),
    ).not.toBeInTheDocument();
    expect(container.querySelector(".topology-edge-contact")).toHaveAttribute(
      "data-offset",
      String(offset),
    );
  });

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
      .toHaveAttribute("d", expect.stringContaining("M -16 -2.25"));
    expect(container.querySelector(".topology-edge-contact-male .topology-edge-contact-rail"))
      .toHaveAttribute("d", expect.stringContaining("M 16 -2.25"));
    expect(paths).toHaveLength(2);
    expect(paths[1]).toHaveAttribute("d", "M 108 0 H 120");
    expect(getByText("240/мин")).toBeInTheDocument();
  });

  it("renders every contact state as a solid interlocked coupling", () => {
    const { container } = renderEdge({ status: "degraded" });
    const rails = container.querySelectorAll(".topology-edge-contact-rail");

    expect(rails).toHaveLength(2);
    rails.forEach((rail) => {
      expect(rail).toHaveStyle({ fill: "#ef4444" });
    });
  });

  it.each([
    [3, "warning"],
    [7, "degraded"],
  ] as const)(
    "keeps the intentional %s-unit gap visible for a %s contact",
    (offset, status) => {
      const { container } = renderEdge({ status });

      expect(container.querySelector(".topology-edge-contact")).toHaveAttribute(
        "data-offset",
        String(offset),
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
      sharedStatuses: ["healthy", "warning", "degraded"],
      renderSharedTrunk: true,
    });
    const trunk = container.querySelectorAll(".topology-edge-shared-trunk");

    expect(container.querySelector("linearGradient")).not.toBeInTheDocument();
    expect(trunk).toHaveLength(3);
    trunk.forEach((lane) => {
      expect(lane).toHaveAttribute("d", "M 0 0 H 24");
      expect(lane).not.toHaveAttribute("stroke-dasharray");
    });
    expect(trunk[0]).toHaveAttribute("stroke", "#22c55e");
    expect(trunk[0]).toHaveAttribute("stroke-width", "6");
    expect(trunk[1]).toHaveAttribute("stroke", "#f59e0b");
    expect(trunk[1]).toHaveAttribute("stroke-width", "1.5");
    expect(trunk[1]).toHaveAttribute("transform", "translate(0 -1.5)");
    expect(trunk[2]).toHaveAttribute("stroke", "#ef4444");
    expect(trunk[2]).toHaveAttribute("stroke-width", "1.5");
    expect(trunk[2]).toHaveAttribute("transform", "translate(0 1.5)");
  });

  it("starts every grouped branch after its shared source trunk", () => {
    const { container } = renderEdge({
      sourceY: 0,
      targetY: 80,
      sharedStatuses: ["healthy", "warning", "degraded"],
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

  it("matches conductor stroke to the straight contact body height", () => {
    const { container } = renderEdge();
    const paths = container.querySelectorAll(".topology-edge-conductor");
    const rails = container.querySelectorAll(".topology-edge-contact-rail");

    paths.forEach((path) => expect(path).toHaveStyle({ strokeWidth: "6" }));
    rails.forEach((rail) => {
      expect(rail).toHaveAttribute("d", expect.stringContaining("-2.25"));
      expect(rail).toHaveAttribute("d", expect.stringContaining("2.25"));
    });
  });

  it("dims the split conductors and contact together", () => {
    const { container } = renderEdge({
      status: "degraded",
      style: { opacity: 0.28 },
    });
    const contact = container.querySelector<SVGElement>(".topology-edge-contact");
    const paths = container.querySelectorAll<SVGElement>(
      ".topology-edge-conductor",
    );

    expect(contact).toHaveStyle({ opacity: "0.28" });
    paths.forEach((path) => expect(path).toHaveStyle({ opacity: "0.28" }));
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
