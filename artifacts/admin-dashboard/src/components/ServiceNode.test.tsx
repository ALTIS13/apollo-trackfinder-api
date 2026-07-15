import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { afterEach, describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo-snapshot";
import { ServiceNode, type ServiceFlowNode } from "./ServiceNode";

afterEach(cleanup);

describe("ServiceNode", () => {
  it("renders the incoming and outgoing status terminals beside the routing handles", () => {
    const node: ServiceFlowNode = {
      id: "core-api",
      type: "service",
      position: { x: 0, y: 0 },
      data: {
        module: demoSnapshot.modules.find((module) => module.id === "core-api")!,
        motionEnabled: false,
        sourceStatuses: ["healthy", "warning", "degraded"],
        targetStatuses: ["healthy"],
      },
    };
    const { container } = render(
      <ReactFlowProvider>
        <ServiceNode
          {...node}
          selected={false}
          selectable={true}
          deletable={false}
          dragging={false}
          draggable={false}
          zIndex={0}
          isConnectable={false}
          positionAbsoluteX={0}
          positionAbsoluteY={0}
        />
      </ReactFlowProvider>,
    );

    expect(container.querySelectorAll(".service-node-terminal")).toHaveLength(2);
    const target = container.querySelector<HTMLElement>(
      ".service-node-terminal--target",
    );
    const source = container.querySelector<HTMLElement>(
      ".service-node-terminal--source",
    );

    expect(target).toHaveAttribute("data-statuses", "healthy");
    expect(target).toHaveStyle({ background: "#22c55e" });
    expect(source).toHaveAttribute(
      "data-statuses",
      "healthy warning degraded",
    );
    expect(source).toHaveStyle({
      background:
        "linear-gradient(to bottom, #22c55e 0 2px, #f59e0b 2px 4px, #ef4444 4px 6px)",
    });
    expect(source).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(container.querySelector(".service-node")).not.toHaveClass("nodrag");
  });
});
