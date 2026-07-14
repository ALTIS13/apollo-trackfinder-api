import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import App from "./App";
import { formatTrafficLabel } from "./components/TopologyPanel";

beforeAll(() => {
  vi.stubGlobal(
    "DOMMatrixReadOnly",
    class DOMMatrixReadOnly {
      m22 = 1;
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      private readonly callback: ResizeObserverCallback;

      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }

      observe(target: Element) {
        this.callback(
          [
            {
              target,
              contentRect: {
                x: 0,
                y: 0,
                top: 0,
                right: 760,
                bottom: 560,
                left: 0,
                width: 760,
                height: 560,
                toJSON: () => ({}),
              },
            } as ResizeObserverEntry,
          ],
          this as unknown as globalThis.ResizeObserver,
        );
      }
      unobserve() {}
      disconnect() {}
    },
  );

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => cleanup());

describe("Apollo TF admin dashboard", () => {
  it("renders the four scan-first metrics before the topology", () => {
    render(<App />);

    const metrics = screen.getByRole("region", { name: "Сводка" });
    const topology = screen.getByRole("region", { name: "Топология сервисов" });

    expect(metrics).toContainElement(screen.getByText("Активные модули"));
    expect(metrics).toContainElement(screen.getByText("Поисков в минуту"));
    expect(metrics).toContainElement(screen.getByText("Глубина очереди"));
    expect(metrics).toContainElement(screen.getByText("Доля ошибок"));
    expect(
      metrics.compareDocumentPosition(topology) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("filters incidents when a service is selected", async () => {
    render(<App />);
    await userEvent.click(
      screen.getByRole("button", { name: "Download Worker" }),
    );
    expect(screen.getByText("Ошибки download-worker")).toBeVisible();
    expect(screen.queryByText("Деградация SoundCloud")).not.toBeInTheDocument();
  });

  it("acknowledges an incident", async () => {
    render(<App />);
    await userEvent.click(
      screen.getByRole("button", {
        name: "Подтвердить инцидент Ошибки download-worker",
      }),
    );
    expect(screen.getByText("Подтверждено")).toBeVisible();
  });

  it("gives every open incident a unique acknowledge action", () => {
    render(<App />);

    expect(
      screen.getByRole("button", {
        name: "Подтвердить инцидент Ошибки download-worker",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: "Подтвердить инцидент Деградация SoundCloud",
      }),
    ).toBeVisible();
  });

  it("keeps traffic labels compact between topology nodes", () => {
    expect(formatTrafficLabel(244)).toBe("244/мин");
  });
});
