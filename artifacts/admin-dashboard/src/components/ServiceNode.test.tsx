import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { afterEach, describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo-snapshot";
import { ServiceNode, type ServiceFlowNode } from "./ServiceNode";

afterEach(cleanup);

describe("ServiceNode", () => {
  it("renders status terminals for the module beside both routing handles", () => {
    const node: ServiceFlowNode = {
      id: "core-api",
      type: "service",
      position: { x: 0, y: 0 },
      data: {
        module: demoSnapshot.modules.find((module) => module.id === "core-api")!,
        motionEnabled: false,
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
    expect(container.querySelector(".service-node-terminal--target")).toHaveAttribute(
      "data-status",
      "warning",
    );
    expect(container.querySelector(".service-node-terminal--source")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });
});
