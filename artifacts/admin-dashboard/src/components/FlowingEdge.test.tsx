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
}

function renderEdge({
  id = "edge-under-test",
  status = "healthy",
  motionEnabled = false,
  sourceY = 0,
  targetY = 0,
  diagnostic,
  style,
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
        }}
        label="240/мин"
        style={style}
      />
    </svg>,
  );
}

describe("FlowingEdge", () => {
  it("merges caller style into the warning path", () => {
    const { container } = renderEdge({
      status: "warning",
      style: { opacity: 0.28 },
    });
    const path = container.querySelector(".react-flow__edge-path");

    expect(path).toHaveStyle({ opacity: "0.28" });
    expect(path).toHaveStyle({ strokeDasharray: "8 6" });
  });

  it.each([
    ["healthy", "connected"],
    ["warning", "unstable"],
    ["degraded", "disconnected"],
    ["unknown", "unknown"],
  ] as const)("renders %s as a %s two-part contact", (status, state) => {
    const { container, getByText } = renderEdge({ status });
    const contact = container.querySelector(".topology-edge-contact");
    const path = container.querySelector(".react-flow__edge-path");

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
    const maskGap = container.querySelector("mask[id^='edge-contact-gap-'] rect:last-child");
    expect(maskGap).toHaveAttribute("width", "32");
    expect(container.querySelector(".topology-edge-contact-female .topology-edge-contact-rail"))
      .toHaveAttribute("d", expect.stringContaining("M -16 -2.25"));
    expect(container.querySelector(".topology-edge-contact-male .topology-edge-contact-rail"))
      .toHaveAttribute("d", expect.stringContaining("M 16 -2.25"));
    expect(path?.getAttribute("style")).toContain("mask");
    expect(getByText("240/мин")).toBeInTheDocument();
  });

  it("renders a healthy contact as one solid interlocked coupling", () => {
    const { container } = renderEdge({ status: "healthy" });
    const rails = container.querySelectorAll(".topology-edge-contact-rail");

    expect(rails).toHaveLength(2);
    rails.forEach((rail) => {
      expect(rail).toHaveStyle({ fill: "#22c55e" });
    });
  });

  it.each(["warning", "degraded", "unknown"] as const)(
    "keeps the intentional gap visible for a %s contact",
    (status) => {
      const { container } = renderEdge({ status });

      container.querySelectorAll(".topology-edge-contact-rail").forEach((rail) => {
        expect(rail).not.toHaveAttribute("style", expect.stringContaining("fill"));
      });
    },
  );

  it("keeps both outer contact ends on the final horizontal segment of a bent edge", () => {
    const { container } = renderEdge({ sourceY: 0, targetY: 80 });
    const contact = container.querySelector(".topology-edge-contact");
    const maskGap = container.querySelector("mask[id^='edge-contact-gap-'] rect:last-child");

    expect(contact).toHaveAttribute("transform", "translate(92 80)");
    expect(maskGap).toHaveAttribute("x", "76");
    expect(maskGap).toHaveAttribute("width", "32");
  });

  it("produces distinct mask IDs for edge IDs that sanitize to the same text", () => {
    const first = renderEdge({ id: "edge:a" });
    const firstMaskId = first.container.querySelector("mask")?.id;
    first.unmount();
    const second = renderEdge({ id: "edge?a" });
    const secondMaskId = second.container.querySelector("mask")?.id;

    expect(firstMaskId).toBeDefined();
    expect(secondMaskId).toBeDefined();
    expect(firstMaskId).not.toBe(secondMaskId);
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
