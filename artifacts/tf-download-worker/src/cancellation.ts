export interface DownloadCancellationStore {
  isCanceled(jobId: string, signal: AbortSignal): Promise<boolean>;
}
