import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { Position } from "@xyflow/react";
import type { CSSProperties } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { FlowingEdge } from "./FlowingEdge";

afterEach(cleanup);

function renderEdge(style?: CSSProperties) {
  return render(
    <svg>
      <FlowingEdge
        id="edge-under-test"
        source="source"
        target="target"
        sourceX={0}
        sourceY={0}
        targetX={120}
        targetY={0}
        sourcePosition={Position.Right}
        targetPosition={Position.Left}
        selected={false}
        selectable={false}
        deletable={false}
        data={{ status: "warning", motionEnabled: false }}
        style={style}
      />
    </svg>,
  );
}

describe("FlowingEdge", () => {
  it("merges caller style into the reduced-motion static path", () => {
    const { container } = renderEdge({ opacity: 0.28 });
    const path = container.querySelector(".react-flow__edge-path");

    expect(path).toHaveStyle({ opacity: "0.28" });
    expect(path).toHaveStyle({ strokeDasharray: "8 6" });
  });

  it("does not render traffic packets when motion is disabled", () => {
    const { container } = renderEdge();
    expect(container.querySelector('path[stroke-dasharray="5 24"]')).not.toBeInTheDocument();
  });
});
