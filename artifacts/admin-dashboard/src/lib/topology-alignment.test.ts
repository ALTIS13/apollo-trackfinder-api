import { describe, expect, it } from "vitest";
import {
  alignTopologyPosition,
  moveTopologyPositionByKeyboard,
  TOPOLOGY_GRID_SIZE,
  TOPOLOGY_MAGNETIC_THRESHOLD_PX,
} from "./topology-alignment";

describe("topology alignment", () => {
  const moving = {
    id: "moving",
    position: { x: 47, y: 49 },
    width: 190,
    height: 76,
  };

  it("snaps positions to the topology grid", () => {
    expect(
      alignTopologyPosition({
        nodeId: "moving",
        position: moving.position,
        width: 190,
        height: 76,
        nodes: [moving],
        zoom: 1,
        mode: "align",
        precision: false,
      }).position,
    ).toEqual({ x: 48, y: 48 });
  });

  it("magnetically aligns the closest anchors and reports guides", () => {
    const peer = {
      id: "peer",
      position: { x: 240, y: 94 },
      width: 190,
      height: 76,
    };
    const result = alignTopologyPosition({
      nodeId: "moving",
      position: moving.position,
      width: 190,
      height: 76,
      nodes: [moving, peer],
      zoom: 1,
      mode: "align",
      precision: false,
    });

    expect(result.position).toEqual({ x: 50, y: 56 });
    expect(result.guides).toEqual([
      { axis: "x", position: 240 },
      { axis: "y", position: 94 },
    ]);
  });

  it("uses an eight screen-pixel magnetic threshold scaled by zoom", () => {
    const peer = {
      id: "peer",
      position: { x: 247, y: 100 },
      width: 190,
      height: 76,
    };

    expect(
      alignTopologyPosition({
        nodeId: "moving",
        position: moving.position,
        width: 190,
        height: 76,
        nodes: [moving, peer],
        zoom: 2,
        mode: "align",
        precision: false,
      }),
    ).toEqual({ position: { x: 48, y: 48 }, guides: [] });

    expect(
      alignTopologyPosition({
        nodeId: "moving",
        position: moving.position,
        width: 190,
        height: 76,
        nodes: [moving, peer],
        zoom: 0.5,
        mode: "align",
        precision: false,
      }).guides,
    ).toEqual([
      { axis: "x", position: 247 },
      { axis: "y", position: 100 },
    ]);
  });

  it("resolves equal-distance anchors by peer id and anchor order", () => {
    const peers = [
      {
        id: "z-peer",
        position: { x: 42, y: 42 },
        width: 190,
        height: 76,
      },
      {
        id: "a-peer",
        position: { x: 54, y: 54 },
        width: 190,
        height: 76,
      },
    ];

    expect(
      alignTopologyPosition({
        nodeId: "moving",
        position: moving.position,
        width: 190,
        height: 76,
        nodes: [moving, ...peers],
        zoom: 1,
        mode: "align",
        precision: false,
      }).position,
    ).toEqual({ x: 54, y: 54 });
  });

  it("bypasses alignment in free and precision modes", () => {
    const peer = {
      id: "peer",
      position: { x: 240, y: 94 },
      width: 190,
      height: 76,
    };

    expect(
      alignTopologyPosition({
        nodeId: "moving",
        position: moving.position,
        width: 190,
        height: 76,
        nodes: [moving, peer],
        zoom: 1,
        mode: "free",
        precision: false,
      }),
    ).toEqual({ position: moving.position, guides: [] });
    expect(
      alignTopologyPosition({
        nodeId: "moving",
        position: moving.position,
        width: 190,
        height: 76,
        nodes: [moving, peer],
        zoom: 1,
        mode: "align",
        precision: true,
      }),
    ).toEqual({ position: moving.position, guides: [] });
  });

  it("moves by grid or precision keyboard steps", () => {
    expect(
      moveTopologyPositionByKeyboard({
        key: "ArrowRight",
        position: { x: 48, y: 48 },
        zoom: 0.5,
        precision: true,
      }),
    ).toEqual({ x: 50, y: 48 });
    expect(
      moveTopologyPositionByKeyboard({
        key: "ArrowUp",
        position: { x: 48, y: 48 },
        zoom: 1,
        precision: false,
      }),
    ).toEqual({ x: 48, y: 24 });
  });

  it("keeps tiny and invalid zoom values finite", () => {
    for (const zoom of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const aligned = alignTopologyPosition({
        nodeId: "moving",
        position: moving.position,
        width: 190,
        height: 76,
        nodes: [moving],
        zoom,
        mode: "align",
        precision: false,
      });
      const moved = moveTopologyPositionByKeyboard({
        key: "ArrowRight",
        position: moving.position,
        zoom,
        precision: true,
      });

      expect(Number.isFinite(aligned.position.x)).toBe(true);
      expect(Number.isFinite(aligned.position.y)).toBe(true);
      expect(Number.isFinite(moved.x)).toBe(true);
      expect(Number.isFinite(moved.y)).toBe(true);
    }
  });

  it("exports the required alignment constants", () => {
    expect(TOPOLOGY_GRID_SIZE).toBe(24);
    expect(TOPOLOGY_MAGNETIC_THRESHOLD_PX).toBe(8);
  });
});
