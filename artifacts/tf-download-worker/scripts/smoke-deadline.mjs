const PRODUCTION_DOWNLOAD_DEADLINE_MS = 30 * 60 * 1_000;
const SMOKE_DOWNLOAD_DEADLINE_MS = 15_000;
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);

globalThis.setTimeout = (callback, delay = 0, ...arguments_) =>
  nativeSetTimeout(
    callback,
    delay === PRODUCTION_DOWNLOAD_DEADLINE_MS
      ? SMOKE_DOWNLOAD_DEADLINE_MS
      : delay,
    ...arguments_,
  );
