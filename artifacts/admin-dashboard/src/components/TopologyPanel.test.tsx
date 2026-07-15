import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo-snapshot";

const flowApi = vi.hoisted(() => ({
  fitView: vi.fn(),
  getNode: vi.fn(),
  getZoom: vi.fn(() => 0.8),
  setCenter: vi.fn(),
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
}));
const motionPreference = vi.hoisted(() => ({ reduced: false }));

vi.mock("@xyflow/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@xyflow/react")>()),
  useReactFlow: () => flowApi,
}));
vi.mock("framer-motion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("framer-motion")>()),
  useReducedMotion: () => motionPreference.reduced,
}));

import {
  getSharedSourceRoutes,
  isDashboardMotionEnabled,
  TopologyPanel,
} from "./TopologyPanel";

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
});

describe("TopologyPanel", () => {
  it("assigns ordered statuses to every shared source edge and the trunk to the last", () => {
    expect(
      Array.from(getSharedSourceRoutes(demoSnapshot.edges).entries()),
    ).toEqual([
      [
        "core-api-account-integrations",
        { statuses: ["healthy", "warning", "degraded"], renderTrunk: false },
      ],
      [
        "core-api-search-media",
        { statuses: ["healthy", "warning", "degraded"], renderTrunk: false },
      ],
      [
        "core-api-download-worker",
        { statuses: ["healthy", "warning", "degraded"], renderTrunk: true },
      ],
    ]);
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

  it("disables evidence-bearing motion when hidden or reduced", () => {
    expect(isDashboardMotionEnabled(true, false)).toBe(true);
    expect(isDashboardMotionEnabled(false, false)).toBe(false);
    expect(isDashboardMotionEnabled(true, true)).toBe(false);
  });
});
