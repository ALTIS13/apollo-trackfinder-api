import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { TrackResult } from "@workspace/api-client-react";
import {
  cancelDownloadJob,
  getDownloadJobStatus,
  queueTrackDownloads,
} from "@workspace/api-client-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrackCard } from "./TrackCard";

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    queueTrackDownloads: vi.fn(),
    getDownloadJobStatus: vi.fn(() => new Promise(() => {})),
    cancelDownloadJob: vi.fn(),
  };
});

vi.mock("@/hooks/use-player", () => ({
  usePlayer: () => ({
    currentTrack: null,
    isPlaying: false,
    isLoading: false,
    playTrack: vi.fn(),
    togglePlayPause: vi.fn(),
    addToQueue: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/lib/tf-session-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/tf-session-client")>();
  return {
    ...actual,
    reportTfAuthError: vi.fn(),
    tfRequestInit: vi.fn((init: RequestInit = {}) => ({
      ...init,
      credentials: "include",
    })),
  };
});

const track: TrackResult = {
  id: "track-1",
  title: "Test Track",
  artist: "Test Artist",
  thumbnailUrl: null,
  duration: 180,
  source: "youtube",
  type: "original",
  quality: [],
  score: 1,
};

beforeEach(() => {
  vi.mocked(queueTrackDownloads).mockReset();
  vi.mocked(getDownloadJobStatus)
    .mockReset()
    .mockImplementation(() => new Promise(() => {}));
  vi.mocked(cancelDownloadJob).mockReset().mockResolvedValue({
    jobId: "job-1",
    status: "canceled",
  });
  vi.stubGlobal("location", { assign: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function expectReservedTerminalRow(label: string) {
  const action = screen.getByTestId("track-download-action");
  const status = within(action).getByRole("status");
  const control = within(action).getByRole("button", { name: "Скачать" });

  expect(action).toHaveClass("h-12");
  expect(control).toHaveClass("h-8");
  expect(status).toHaveClass("h-4");
  expect(status).toHaveTextContent(label);
  expect(status.previousElementSibling).toBe(control);
  expect(action.querySelector('[class~="absolute"]')).toBeNull();
}

describe("TrackCard download action", () => {
  it("queues one track from its download action without resizing the action area", async () => {
    vi.mocked(queueTrackDownloads).mockResolvedValue({
      results: [{ trackId: track.id, jobId: "job-1", position: 1 }],
    });
    render(<TrackCard track={track} index={0} />);

    const action = screen.getByTestId("track-download-action");
    fireEvent.click(screen.getByRole("button", { name: "Скачать" }));

    await waitFor(() => expect(queueTrackDownloads).toHaveBeenCalledTimes(1));
    expect(action).toHaveClass("h-12");
    expect(screen.getByTitle("Отменить загрузку")).toHaveAttribute(
      "aria-label",
      "Отменить загрузку",
    );
    expect(screen.getByTitle("Загрузка")).toHaveAttribute(
      "aria-label",
      "Загрузка",
    );
  });

  it("renders bounded failure feedback and keeps a retryable download control", async () => {
    vi.mocked(queueTrackDownloads).mockRejectedValue(
      new Error("secret provider response"),
    );
    render(<TrackCard track={track} index={0} />);

    fireEvent.click(screen.getByRole("button", { name: "Скачать" }));

    await screen.findByText("Не удалось начать загрузку.");
    expectReservedTerminalRow("Не удалось начать загрузку.");
    expect(screen.getByRole("button", { name: "Скачать" })).not.toBeDisabled();
  });

  it("renders canceled feedback in the reserved non-overlapping row", async () => {
    vi.mocked(queueTrackDownloads).mockImplementation(
      () => new Promise(() => {}),
    );
    render(<TrackCard track={track} index={0} />);

    fireEvent.click(screen.getByRole("button", { name: "Скачать" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Отменить загрузку" }),
    );

    await screen.findByText("Загрузка отменена");
    expectReservedTerminalRow("Загрузка отменена");
  });

  it("renders completed feedback in the reserved non-overlapping row", async () => {
    vi.mocked(queueTrackDownloads).mockResolvedValue({
      results: [{ trackId: track.id, jobId: "job-1", position: 1 }],
    });
    vi.mocked(getDownloadJobStatus).mockResolvedValue({
      status: "completed",
      progress: 100,
    });
    render(<TrackCard track={track} index={0} />);

    fireEvent.click(screen.getByRole("button", { name: "Скачать" }));

    await screen.findByText("Файл открывается");
    expectReservedTerminalRow("Файл открывается");
    expect(screen.getByRole("button", { name: "Скачать" })).toBeDisabled();
  });
});
