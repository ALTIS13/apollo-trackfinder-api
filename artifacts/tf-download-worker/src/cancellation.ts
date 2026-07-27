export interface DownloadCancellationStore {
  arm(jobId: string, signal: AbortSignal): Promise<boolean>;
  isCanceled(jobId: string, signal: AbortSignal): Promise<boolean>;
  finish(jobId: string, signal: AbortSignal): Promise<boolean>;
}
