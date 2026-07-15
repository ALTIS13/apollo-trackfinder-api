import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo-snapshot";
import {
  CONNECTOR_BEND_RADIUS,
  CONTACT_HALF_LENGTH,
  TARGET_STUB_LENGTH,
} from "../lib/topology-connector-geometry";

const flowApi = vi.hoisted(() => ({
  fitView: vi.fn(),
  getNode: vi.fn(),
  getZoom: vi.fn(() => 0.8),
  setCenter: vi.fn(),
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
}));
const motionPreference = vi.hoisted(() => ({ reduced: false }));
const reactFlowProps = vi.hoisted(() => ({ latest: undefined as unknown }));

vi.mock("@xyflow/react", async (importOriginal) => {
  const original = await importOriginal<typeof import("@xyflow/react")>();
  const React = await import("react");

  return {
    ...original,
    ReactFlow: (props: React.ComponentProps<typeof original.ReactFlow>) => {
      reactFlowProps.latest = props;
      return React.createElement(original.ReactFlow, props);
    },
    useReactFlow: () => flowApi,
  };
});
vi.mock("framer-motion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("framer-motion")>()),
  useReducedMotion: () => motionPreference.reduced,
}));

import {
  getSharedSourceRoutes,
  isDashboardMotionEnabled,
  TopologyPanel,
} from "./TopologyPanel";

function StatefulTopologyPanel() {
  const [selectedServiceId, setSelectedServiceId] = useState<string>();

  return (
    <TopologyPanel
      snapshot={demoSnapshot}
      selectedServiceId={selectedServiceId}
      onSelectService={setSelectedServiceId}
    />
  );
}

beforeAll(() => {
  vi.stubGlobal("DOMMatrixReadOnly", class DOMMatrixReadOnly { m22 = 1; });
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.callback(
          [{ target, contentRect: { width: 760, height: 560 } } as ResizeObserverEntry],
          this as unknown as globalThis.ResizeObserver,
        );
      }
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  flowApi.setCenter.mockReset();
  flowApi.getNode.mockReset();
  motionPreference.reduced = false;
  reactFlowProps.latest = undefined;
});

function getReactFlowProps() {
  if (reactFlowProps.latest === undefined)
    throw new Error("React Flow props were not captured");

  return reactFlowProps.latest as {
    nodes: Array<{
      id: string;
      position: { x: number; y: number };
      width?: number;
      height?: number;
      measured?: { width?: number; height?: number };
    }>;
    edges: Array<{
      id: string;
      source: string;
      target: string;
      data?: {
        sharedBranchLength?: number;
        renderSharedTrunk?: boolean;
      };
    }>;
    onNodesChange: (changes: unknown[]) => void;
    snapToGrid?: boolean;
    snapGrid?: [number, number];
  };
}

describe("TopologyPanel", () => {
  it("assigns ordered statuses to every shared source edge and the trunk to the last", () => {
    expect(
      Array.from(
        getSharedSourceRoutes(
          demoSnapshot.edges,
          new Map([
            ["core-api", { x: 298, width: 190 }],
            ["account-integrations", { x: 572, width: 190 }],
            ["search-media", { x: 572, width: 190 }],
            ["download-worker", { x: 572, width: 190 }],
          ]),
        ).entries(),
      ),
    ).toEqual([
      [
        "core-api-account-integrations",
        {
          statuses: ["healthy", "warning", "degraded"],
          renderTrunk: false,
          sharedBranchLength: 24,
        },
      ],
      [
        "core-api-search-media",
        {
          statuses: ["healthy", "warning", "degraded"],
          renderTrunk: false,
          sharedBranchLength: 24,
        },
      ],
      [
        "core-api-download-worker",
        {
          statuses: ["healthy", "warning", "degraded"],
          renderTrunk: true,
          sharedBranchLength: 24,
        },
      ],
    ]);
  });

  it("keeps every shared Core API branch on one shortened trunk after the trunk owner moves left", async () => {
    render(<TopologyPanel snapshot={demoSnapshot} onSelectService={vi.fn()} />);

    await waitFor(() => expect(reactFlowProps.latest).toBeDefined());
    fireEvent.click(screen.getByRole("radio", { name: "Свободно" }));
    const coreNode = getReactFlowProps().nodes.find((node) => node.id === "core-api");
    if (coreNode === undefined) throw new Error("Core API node was not rendered");
    const coreWidth = coreNode.width ?? coreNode.measured?.width;
    if (coreWidth === undefined) throw new Error("Core API node width was not measured");
    const targetX =
      coreNode.position.x +
      coreWidth +
      CONNECTOR_BEND_RADIUS +
      2 * CONTACT_HALF_LENGTH +
      TARGET_STUB_LENGTH +
      6.436;
    act(() => {
      getReactFlowProps().onNodesChange([
        {
          type: "position",
          id: "download-worker",
          position: { x: targetX, y: 140 },
        },
      ]);
    });

    await waitFor(() => {
      const sharedRoutes = getReactFlowProps().edges.filter(
        (edge) => edge.source === "core-api",
      );
      const branchLengths = sharedRoutes.map(
        (edge) => edge.data?.sharedBranchLength,
      );

      expect(branchLengths).toHaveLength(3);
      expect(branchLengths.every((length) => typeof length === "number")).toBe(true);

      const numericBranchLengths = branchLengths as number[];
      numericBranchLengths.forEach((length) =>
        expect(length).toBeCloseTo(numericBranchLengths[0], 6),
      );
      expect(numericBranchLengths[0]).toBeCloseTo(6.436, 3);
      expect(numericBranchLengths[0]).toBeGreaterThan(0);
      expect(numericBranchLengths[0]).toBeLessThan(24);
      expect(
        sharedRoutes.filter((edge) => edge.data?.renderSharedTrunk),
      ).toHaveLength(1);
      expect(
        sharedRoutes.find((edge) => edge.data?.renderSharedTrunk)?.id,
      ).toBe("core-api-download-worker");
    });
  });

  it("disables the shared trunk for every branch when one target has no clearance", () => {
    const routes = getSharedSourceRoutes(
      demoSnapshot.edges,
      new Map([
        ["core-api", { x: 298, width: 190 }],
        ["account-integrations", { x: 572, width: 190 }],
        ["search-media", { x: 572, width: 190 }],
        ["download-worker", { x: 539.5, width: 190 }],
      ]),
    );

    expect(
      Array.from(routes.values(), (route) => route.sharedBranchLength),
    ).toEqual([0, 0, 0]);
  });

  it("centers an incident-selected node with zero-duration reduced motion", async () => {
    motionPreference.reduced = true;
    flowApi.getNode.mockReturnValue({ position: { x: 100, y: 200 }, width: 190, height: 76 });

    render(
      <TopologyPanel
        snapshot={demoSnapshot}
        selectedServiceId="download-worker"
        onSelectService={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(flowApi.setCenter).toHaveBeenCalledWith(195, 238, { duration: 0, zoom: 0.8 }),
    );
  });

  it.each([
    { reduced: true, behavior: "auto" as const },
    { reduced: false, behavior: "smooth" as const },
  ])(
    "scrolls a 335px outer viewport to the selected node with $behavior behavior",
    async ({ reduced, behavior }) => {
      motionPreference.reduced = reduced;
      flowApi.getNode.mockReturnValue({
        position: { x: 520, y: 200 },
        width: 190,
        height: 76,
      });
      const { container, rerender } = render(
        <TopologyPanel
          snapshot={demoSnapshot}
          onSelectService={vi.fn()}
        />,
      );
      const scroller = container.querySelector<HTMLElement>(".topology-scroll");
      if (scroller === null) throw new Error("Не найден скроллер топологии");
      const scrollTo = vi.fn();
      Object.defineProperties(scroller, {
        clientWidth: { configurable: true, value: 335 },
        scrollWidth: { configurable: true, value: 760 },
        scrollTo: { configurable: true, value: scrollTo },
      });

      rerender(
        <TopologyPanel
          snapshot={demoSnapshot}
          selectedServiceId="download-worker"
          onSelectService={vi.fn()}
        />,
      );

      await waitFor(() =>
        expect(scrollTo).toHaveBeenCalledWith({
          behavior,
          left: 212.5,
          top: 0,
        }),
      );
      expect(flowApi.setCenter).toHaveBeenCalledWith(615, 238, {
        duration: reduced ? 0 : 240,
        zoom: 0.8,
      });
    },
  );

  it("keeps React Flow nodes keyboard focusable and synchronizes keyboard selection", async () => {
    const onSelectService = vi.fn();
    render(<TopologyPanel snapshot={demoSnapshot} onSelectService={onSelectService} />);
    const node = await screen.findByTestId("rf__node-download-worker");

    expect(node).toHaveAttribute("tabindex", "0");
    node.focus();
    fireEvent.keyDown(node, { key: "Enter" });

    await waitFor(() => expect(onSelectService).toHaveBeenCalledWith("download-worker"));
  });

  it("switches alignment mode without moving controlled nodes and exposes grid snap props", async () => {
    render(<TopologyPanel snapshot={demoSnapshot} onSelectService={vi.fn()} />);

    await waitFor(() => expect(reactFlowProps.latest).toBeDefined());
    const initialPosition = {
      ...getReactFlowProps().nodes.find((node) => node.id === "core-api")!.position,
    };
    expect(screen.getByRole("radio", { name: "Выровнять" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "Свободно" }));
    expect(getReactFlowProps().snapToGrid).toBe(false);
    expect(getReactFlowProps().nodes.find((node) => node.id === "core-api")?.position).toEqual(
      initialPosition,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Выровнять" }));
    expect(getReactFlowProps().snapGrid).toEqual([24, 24]);
    expect(getReactFlowProps().nodes.find((node) => node.id === "core-api")?.position).toEqual(
      initialPosition,
    );
  });

  it("uses a roving tab stop and arrow keys to select alignment modes", async () => {
    render(<TopologyPanel snapshot={demoSnapshot} onSelectService={vi.fn()} />);

    await waitFor(() => expect(reactFlowProps.latest).toBeDefined());
    const initialPosition = {
      ...getReactFlowProps().nodes.find((node) => node.id === "core-api")!.position,
    };
    const freeMode = screen.getByRole("radio", { name: "Свободно" });
    const alignMode = screen.getByRole("radio", { name: "Выровнять" });

    expect(freeMode).toHaveAttribute("tabindex", "-1");
    expect(alignMode).toHaveAttribute("tabindex", "0");
    alignMode.focus();

    fireEvent.keyDown(alignMode, { key: "ArrowLeft" });
    expect(freeMode).toBeChecked();
    expect(freeMode).toHaveFocus();
    expect(freeMode).toHaveAttribute("tabindex", "0");
    expect(alignMode).toHaveAttribute("tabindex", "-1");

    fireEvent.keyDown(freeMode, { key: "ArrowRight" });
    expect(alignMode).toBeChecked();
    expect(alignMode).toHaveFocus();

    fireEvent.keyDown(alignMode, { key: "ArrowUp" });
    expect(freeMode).toBeChecked();
    expect(freeMode).toHaveFocus();

    fireEvent.keyDown(freeMode, { key: "ArrowDown" });
    expect(alignMode).toBeChecked();
    expect(alignMode).toHaveFocus();
    expect(getReactFlowProps().nodes.find((node) => node.id === "core-api")?.position).toEqual(
      initialPosition,
    );
  });

  it("normalizes aligned drags, publishes nearby guides, and preserves free drags", async () => {
    const view = render(<TopologyPanel snapshot={demoSnapshot} onSelectService={vi.fn()} />);

    await waitFor(() => expect(reactFlowProps.latest).toBeDefined());
    fireEvent.click(screen.getByRole("radio", { name: "Свободно" }));
    act(() => {
      getReactFlowProps().onNodesChange([
        {
          type: "position",
          id: "account-integrations",
          position: { x: 238, y: 72 },
        },
      ]);
    });
    fireEvent.click(screen.getByRole("radio", { name: "Выровнять" }));

    act(() => {
      getReactFlowProps().onNodesChange([
        {
          type: "position",
          id: "core-api",
          position: { x: 49, y: 71 },
          dragging: true,
        },
      ]);
    });
    await waitFor(() =>
      expect(getReactFlowProps().nodes.find((node) => node.id === "core-api")?.position).toEqual({
        x: 48,
        y: 72,
      }),
    );
    expect(view.container.querySelectorAll("[data-alignment-axis]")).toHaveLength(2);

    act(() => {
      getReactFlowProps().onNodesChange([
        {
          type: "position",
          id: "core-api",
          position: { x: 48, y: 72 },
          dragging: false,
        },
      ]);
    });
    await waitFor(() =>
      expect(view.container.querySelectorAll("[data-alignment-axis]")).toHaveLength(0),
    );

    fireEvent.click(screen.getByRole("radio", { name: "Свободно" }));
    act(() => {
      getReactFlowProps().onNodesChange([
        { type: "position", id: "core-api", position: { x: 49, y: 71 } },
      ]);
    });
    await waitFor(() =>
      expect(getReactFlowProps().nodes.find((node) => node.id === "core-api")?.position).toEqual({
        x: 49,
        y: 71,
      }),
    );
  });

  it("moves focused nodes by the alignment grid and uses zoom-aware Alt precision", async () => {
    render(<TopologyPanel snapshot={demoSnapshot} onSelectService={vi.fn()} />);

    const node = await screen.findByTestId("rf__node-core-api");
    const initialPosition = {
      ...getReactFlowProps().nodes.find((item) => item.id === "core-api")!.position,
    };
    node.focus();
    fireEvent.keyDown(node, { key: "ArrowRight" });
    await waitFor(() => {
      const updatedPosition = getReactFlowProps().nodes.find(
        (item) => item.id === "core-api",
      )!.position;
      expect(updatedPosition.x - initialPosition.x).toBe(24);
    });
    const updatedPosition = {
      ...getReactFlowProps().nodes.find((item) => item.id === "core-api")!.position,
    };
    fireEvent.keyDown(node, { key: "ArrowRight", altKey: true });
    await waitFor(() => {
      const nextPosition = getReactFlowProps().nodes.find(
        (item) => item.id === "core-api",
      )!.position;
      expect(nextPosition.x - updatedPosition.x).toBeCloseTo(1 / 0.8, 6);
    });
  });

  it("clears alignment guides when changing mode or resetting layout", async () => {
    const view = render(<TopologyPanel snapshot={demoSnapshot} onSelectService={vi.fn()} />);

    await waitFor(() => expect(reactFlowProps.latest).toBeDefined());
    fireEvent.click(screen.getByRole("radio", { name: "Свободно" }));
    act(() => {
      getReactFlowProps().onNodesChange([
        { type: "position", id: "account-integrations", position: { x: 238, y: 72 } },
      ]);
    });
    fireEvent.click(screen.getByRole("radio", { name: "Выровнять" }));
    act(() => {
      getReactFlowProps().onNodesChange([
        {
          type: "position",
          id: "core-api",
          position: { x: 49, y: 71 },
          dragging: true,
        },
      ]);
    });
    await waitFor(() =>
      expect(view.container.querySelectorAll("[data-alignment-axis]")).toHaveLength(2),
    );

    fireEvent.click(screen.getByRole("radio", { name: "Свободно" }));
    await waitFor(() =>
      expect(view.container.querySelectorAll("[data-alignment-axis]")).toHaveLength(0),
    );

    fireEvent.click(screen.getByRole("radio", { name: "Выровнять" }));
    act(() => {
      getReactFlowProps().onNodesChange([
        {
          type: "position",
          id: "core-api",
          position: { x: 49, y: 71 },
          dragging: true,
        },
      ]);
    });
    await waitFor(() =>
      expect(view.container.querySelectorAll("[data-alignment-axis]")).toHaveLength(2),
    );
    fireEvent.click(screen.getByRole("button", { name: "Сбросить раскладку" }));
    await waitFor(() =>
      expect(view.container.querySelectorAll("[data-alignment-axis]")).toHaveLength(0),
    );
  });

  it("starts a remounted panel without transient alignment guides", async () => {
    const firstMount = render(
      <TopologyPanel snapshot={demoSnapshot} onSelectService={vi.fn()} />,
    );

    await waitFor(() => expect(reactFlowProps.latest).toBeDefined());
    fireEvent.click(screen.getByRole("radio", { name: "Свободно" }));
    act(() => {
      getReactFlowProps().onNodesChange([
        { type: "position", id: "account-integrations", position: { x: 238, y: 72 } },
      ]);
    });
    fireEvent.click(screen.getByRole("radio", { name: "Выровнять" }));
    act(() => {
      getReactFlowProps().onNodesChange([
        {
          type: "position",
          id: "core-api",
          position: { x: 49, y: 71 },
          dragging: true,
        },
      ]);
    });
    await waitFor(() =>
      expect(firstMount.container.querySelectorAll("[data-alignment-axis]")).toHaveLength(2),
    );

    firstMount.unmount();
    const secondMount = render(
      <TopologyPanel snapshot={demoSnapshot} onSelectService={vi.fn()} />,
    );

    await waitFor(() => expect(reactFlowProps.latest).toBeDefined());
    expect(secondMount.container.querySelectorAll("[data-alignment-axis]")).toHaveLength(0);
  });

  it("enables layout reset after a draggable node position change and clears the session layout", async () => {
    render(<StatefulTopologyPanel />);

    const resetLayout = screen.getByRole("button", {
      name: "Сбросить раскладку",
    });
    expect(resetLayout).toBeDisabled();

    const node = await screen.findByTestId("rf__node-core-api");
    const initialTransform = node.style.transform;
    expect(node).toHaveClass("draggable");
    fireEvent.keyDown(node, { key: "Enter" });
    fireEvent.keyDown(node, { key: "ArrowRight" });

    await waitFor(() => {
      expect(resetLayout).toBeEnabled();
      expect(node.style.transform).not.toBe(initialTransform);
    });
    fireEvent.click(resetLayout);
    await waitFor(() => {
      expect(resetLayout).toBeDisabled();
      expect(node.style.transform).toBe(initialTransform);
    });
  });

  it("retains measured dimensions after consecutive controlled drag updates", async () => {
    render(<TopologyPanel snapshot={demoSnapshot} onSelectService={vi.fn()} />);

    await waitFor(() => expect(reactFlowProps.latest).toBeDefined());
    fireEvent.click(screen.getByRole("radio", { name: "Свободно" }));
    const initialNode = getReactFlowProps().nodes.find((node) => node.id === "core-api");
    if (initialNode === undefined) throw new Error("Core API node was not rendered");

    act(() => {
      getReactFlowProps().onNodesChange([
        { type: "position", id: "core-api", position: { x: 640, y: 120 } },
      ]);
    });
    await waitFor(() =>
      expect(getReactFlowProps().nodes.find((node) => node.id === "core-api")?.position).toEqual({
        x: 640,
        y: 120,
      }),
    );

    act(() => {
      getReactFlowProps().onNodesChange([
        { type: "position", id: "core-api", position: { x: 680, y: 152 } },
      ]);
    });
    await waitFor(() => {
      const node = getReactFlowProps().nodes.find((item) => item.id === "core-api");
      expect(node?.position).toEqual({ x: 680, y: 152 });
      expect(node?.measured).toEqual({
        width: initialNode.width,
        height: initialNode.height,
      });
    });
  });

  it("does not retain a dragged node position after unmount and remount", async () => {
    const firstMount = render(
      <TopologyPanel snapshot={demoSnapshot} onSelectService={vi.fn()} />,
    );

    await waitFor(() => expect(reactFlowProps.latest).toBeDefined());
    fireEvent.click(screen.getByRole("radio", { name: "Свободно" }));
    const initialPosition = {
      ...getReactFlowProps().nodes.find((node) => node.id === "core-api")!.position,
    };
    act(() => {
      getReactFlowProps().onNodesChange([
        { type: "position", id: "core-api", position: { x: 680, y: 152 } },
      ]);
    });
    await waitFor(() =>
      expect(
        getReactFlowProps().nodes.find((node) => node.id === "core-api")?.position,
      ).toEqual({ x: 680, y: 152 }),
    );

    firstMount.unmount();
    render(<TopologyPanel snapshot={demoSnapshot} onSelectService={vi.fn()} />);

    await waitFor(() =>
      expect(
        getReactFlowProps().nodes.find((node) => node.id === "core-api")?.position,
      ).toEqual(initialPosition),
    );
  });

  it("disables evidence-bearing motion when hidden or reduced", () => {
    expect(isDashboardMotionEnabled(true, false)).toBe(true);
    expect(isDashboardMotionEnabled(false, false)).toBe(false);
    expect(isDashboardMotionEnabled(true, true)).toBe(false);
  });
});
