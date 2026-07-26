export type DownloadLogState = "started" | "completed" | "failed" | "canceled";

export interface DownloadLogEvent {
  readonly jobId: string;
  readonly state: DownloadLogState;
  readonly code?:
    | "download_canceled"
    | "invalid_job"
    | "source_not_allowed"
    | "download_failed"
    | "output_too_large"
    | "deadline_exceeded"
    | "storage_quota_exceeded"
    | "storage_unavailable";
  readonly durationMs?: number;
  readonly size?: number;
}

export interface DownloadLogger {
  info(event: DownloadLogEvent): void;
  warn(event: DownloadLogEvent): void;
  error(event: DownloadLogEvent): void;
}

export const noopDownloadLogger: DownloadLogger = {
  info() {},
  warn() {},
  error() {},
};
