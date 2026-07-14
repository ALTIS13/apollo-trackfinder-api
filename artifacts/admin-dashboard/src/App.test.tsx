import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import App from "./App";
import { formatTrafficLabel } from "./components/TopologyPanel";
import { demoSnapshot } from "./data/demo-snapshot";
import type { DashboardSnapshot, DashboardSnapshotAdapter } from "./types/dashboard";

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

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function snapshotAt(generatedAt: string): DashboardSnapshot {
  return { ...demoSnapshot, generatedAt };
}

function createAdapter(
  loadSnapshot: DashboardSnapshotAdapter["loadSnapshot"],
  initialSnapshot: DashboardSnapshot | null = demoSnapshot,
  mode: "demo" | "http" = "demo",
): DashboardSnapshotAdapter {
  return {
    mode,
    capabilities: {
      canAcknowledgeIncidents: mode === "demo",
    },
    initialSnapshot: initialSnapshot ?? undefined,
    loadSnapshot,
  };
}

describe("Apollo TF admin dashboard", () => {
  it("renders the operational shell landmarks and real section navigation", () => {
    render(<App />);

    expect(screen.getByRole("navigation", { name: "Разделы панели" })).toBeVisible();
    expect(screen.getByRole("banner")).toBeVisible();
    expect(screen.getByRole("main")).toBeVisible();

    const expectedAnchors = [
      ["Сводка", "#summary"],
      ["Топология", "#topology"],
      ["Инциденты", "#incidents"],
      ["Деплойменты", "#deployments"],
      ["Провайдеры", "#providers"],
    ];
    for (const [name, href] of expectedAnchors) {
      expect(screen.getByRole("link", { name })).toHaveAttribute("href", href);
    }
  });

  it("keeps deployment and provider operating data visible as semantic tables", () => {
    render(<App />);

    const deployments = screen.getByRole("table", { name: "Деплойменты сервисов" });
    expect(deployments).toHaveTextContent("Core API");
    expect(deployments).toHaveTextContent("2.14.0");
    expect(deployments).toHaveTextContent("2.14.1");
    expect(deployments).toHaveTextContent("Доступно обновление");
    expect(deployments).toHaveTextContent("Последний деплой");

    const providers = screen.getByRole("table", { name: "Состояние провайдеров" });
    expect(providers).toHaveTextContent("SoundCloud");
    expect(providers).toHaveTextContent("812 мс");
    expect(providers).toHaveTextContent("Предупреждение");
    expect(providers).toHaveTextContent("Проверено");
    expect(providers).toHaveTextContent("Тренд");
  });

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

  it("routes incident focus through the selected React Flow node", async () => {
    render(<App />);

    await userEvent.click(
      screen.getByRole("button", {
        name: "Показать сервис: Ошибки download-worker",
      }),
    );

    expect(
      screen.getByRole("button", { name: "Download Worker" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("toggles between all and open incidents", async () => {
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Открытые" }));
    expect(screen.queryByText("Задержка интеграций аккаунта")).not.toBeInTheDocument();
    expect(screen.getByText("Ошибки download-worker")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Все" }));
    expect(screen.getByText("Задержка интеграций аккаунта")).toBeVisible();
  });

  it("resets service selection and restores all incidents", async () => {
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Download Worker" }));
    await userEvent.click(screen.getByRole("button", { name: "Сбросить выбор" }));

    expect(screen.getByText("Деградация SoundCloud")).toBeVisible();
    expect(screen.getByRole("button", { name: "Download Worker" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
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

  it("keeps acknowledgement focus and announces feedback", async () => {
    render(<App />);
    const action = screen.getByRole("button", {
      name: "Подтвердить инцидент Ошибки download-worker",
    });

    action.focus();
    await userEvent.click(action);

    expect(screen.getByRole("button", { name: "Инцидент Ошибки download-worker подтвержден" })).toHaveFocus();
    expect(screen.getByRole("status", { name: "Состояние инцидентов" })).toHaveTextContent(
      "Инцидент «Ошибки download-worker» подтвержден",
    );
  });

  it("moves focus to stable feedback when acknowledgement removes an open row", async () => {
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Открытые" }));

    await userEvent.click(
      screen.getByRole("button", {
        name: "Подтвердить инцидент Ошибки download-worker",
      }),
    );

    const feedback = screen.getByRole("status", {
      name: "Состояние инцидентов",
    });
    await waitFor(() => expect(feedback).toHaveFocus());
    expect(feedback).toHaveTextContent(
      "Инцидент «Ошибки download-worker» подтвержден",
    );
    expect(screen.queryByText("Ошибки download-worker")).not.toBeInTheDocument();
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

  it("shows refreshing state and the adapter timestamp after manual refresh", async () => {
    let resolveRefresh!: (snapshot: DashboardSnapshot) => void;
    const loadSnapshot = vi.fn(
      () =>
        new Promise<DashboardSnapshot>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    render(<App adapter={createAdapter(loadSnapshot)} />);

    await userEvent.click(screen.getByRole("button", { name: "Обновить" }));
    expect(screen.getByTestId("dashboard-connection-status")).toHaveTextContent("Обновление");
    expect(screen.getByRole("button", { name: "Обновление" })).toBeDisabled();

    resolveRefresh(snapshotAt("2026-07-14T09:45:00.000Z"));
    await waitFor(() =>
      expect(screen.getByTestId("dashboard-connection-status")).toHaveTextContent("Актуально"),
    );
    expect(screen.getByText("12:45")).toHaveAttribute("datetime", "2026-07-14T09:45:00.000Z");
    expect(loadSnapshot).toHaveBeenCalledTimes(1);
  });

  it("keeps a local acknowledgement after a successful refresh", async () => {
    const loadSnapshot = vi
      .fn()
      .mockResolvedValue(snapshotAt("2026-07-14T09:45:00.000Z"));
    render(<App adapter={createAdapter(loadSnapshot)} />);

    await userEvent.click(
      screen.getByRole("button", {
        name: "Подтвердить инцидент Ошибки download-worker",
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Обновить" }));

    await waitFor(() =>
      expect(screen.getByTestId("dashboard-connection-status")).toHaveTextContent(
        "Актуально",
      ),
    );
    expect(
      screen.getByRole("button", {
        name: "Инцидент Ошибки download-worker подтвержден",
      }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", {
        name: "Подтвердить инцидент Ошибки download-worker",
      }),
    ).not.toBeInTheDocument();
  });

  it("requests configured HTTP data on mount despite the visual fallback", async () => {
    const loadSnapshot = vi.fn(
      () => new Promise<DashboardSnapshot>(() => undefined),
    );

    render(<App adapter={createAdapter(loadSnapshot, demoSnapshot, "http")} />);

    await waitFor(() => expect(loadSnapshot).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("dashboard-connection-status")).toHaveTextContent(
      "Обновление",
    );
    expect(screen.getByText("Активные модули")).toBeVisible();
  });

  it("shows offline after the first HTTP request fails while retaining fallback data", async () => {
    const loadSnapshot = vi.fn().mockRejectedValue(new Error("offline"));

    render(<App adapter={createAdapter(loadSnapshot, demoSnapshot, "http")} />);

    await waitFor(() =>
      expect(screen.getByTestId("dashboard-connection-status")).toHaveTextContent(
        "Нет связи",
      ),
    );
    expect(loadSnapshot).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Активные модули")).toBeVisible();
  });

  it("shows stale only when an HTTP request fails after verified remote data", async () => {
    const loadSnapshot = vi
      .fn()
      .mockResolvedValueOnce(snapshotAt("2026-07-14T09:45:00.000Z"))
      .mockRejectedValueOnce(new Error("offline"));

    render(<App adapter={createAdapter(loadSnapshot, demoSnapshot, "http")} />);

    await waitFor(() =>
      expect(screen.getByTestId("dashboard-connection-status")).toHaveTextContent(
        "Актуально",
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: "Обновить" }));
    await waitFor(() =>
      expect(screen.getByTestId("dashboard-connection-status")).toHaveTextContent(
        "Данные устарели",
      ),
    );
  });

  it("keeps remote incidents read-only and explains the capability", async () => {
    const loadSnapshot = vi.fn().mockResolvedValue(demoSnapshot);

    render(<App adapter={createAdapter(loadSnapshot, demoSnapshot, "http")} />);

    expect(
      screen.getByText("Удаленные инциденты доступны только для чтения"),
    ).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: "Инцидент Ошибки download-worker: подтверждение недоступно в режиме только для чтения",
      }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", {
        name: "Подтвердить инцидент Ошибки download-worker",
      }),
    ).not.toBeInTheDocument();
  });

  it("refreshes through the adapter every 15 seconds when enabled", async () => {
    vi.useFakeTimers();
    const loadSnapshot = vi.fn().mockResolvedValue(snapshotAt("2026-07-14T09:45:00.000Z"));
    render(<App adapter={createAdapter(loadSnapshot)} />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Автообновление" }));
    await act(async () => vi.advanceTimersByTime(15_000));

    expect(loadSnapshot).toHaveBeenCalledTimes(1);
  });

  it("keeps the last snapshot visible when refresh fails", async () => {
    const loadSnapshot = vi.fn().mockRejectedValue(new Error("network unavailable"));
    render(<App adapter={createAdapter(loadSnapshot)} />);

    await userEvent.click(screen.getByRole("button", { name: "Обновить" }));

    await waitFor(() =>
      expect(screen.getByTestId("dashboard-connection-status")).toHaveTextContent("Данные устарели"),
    );
    expect(screen.getByText("Активные модули")).toBeVisible();
    expect(screen.getByRole("button", { name: "Download Worker" })).toBeVisible();
  });

  it("shows offline state when the adapter has no last known snapshot", async () => {
    const loadSnapshot = vi.fn().mockRejectedValue(new Error("offline"));
    render(<App adapter={createAdapter(loadSnapshot, null)} />);

    await waitFor(() =>
      expect(screen.getByTestId("dashboard-connection-status")).toHaveTextContent("Нет связи"),
    );
    expect(screen.getByText("Нет сохраненного снимка")).toBeVisible();
  });
});
