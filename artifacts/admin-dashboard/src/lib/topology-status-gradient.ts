import type { HealthStatus } from "../types/dashboard";
import type { SharedStatusBand } from "./topology-shared-routes";

export interface StatusGradientStop {
  offset: number;
  status: HealthStatus;
}

export function buildStatusGradientStops(
  bands: readonly SharedStatusBand[],
): StatusGradientStop[] {
  if (
    bands.length === 0 ||
    bands.some((band) => !Number.isFinite(band.count) || band.count <= 0)
  )
    return [];
  const total = bands.reduce((sum, band) => sum + band.count, 0);
  if (!Number.isFinite(total)) return [];
  if (bands.length === 1) {
    return [
      { offset: 0, status: bands[0]!.status },
      { offset: 1, status: bands[0]!.status },
    ];
  }

  const stops: StatusGradientStop[] = [{ offset: 0, status: bands[0]!.status }];
  let consumed = bands[0]!.count;
  for (let index = 1; index < bands.length; index += 1) {
    const previousWidth = bands[index - 1]!.count / total;
    const nextWidth = bands[index]!.count / total;
    const boundary = consumed / total;
    const halfTransition = Math.min(0.04, previousWidth / 4, nextWidth / 4);
    stops.push(
      { offset: boundary - halfTransition, status: bands[index - 1]!.status },
      { offset: boundary + halfTransition, status: bands[index]!.status },
    );
    consumed += bands[index]!.count;
  }
  stops.push({ offset: 1, status: bands[bands.length - 1]!.status });
  return stops;
}
