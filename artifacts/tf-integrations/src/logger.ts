import type {
  TfIntegrationOperation,
  TfIntegrationsErrorResponse,
} from "@workspace/tf-integrations-contract";

export type TfIntegrationsErrorCode =
  TfIntegrationsErrorResponse["error"]["code"];

export interface IntegrationsLogger {
  error(
    event: Readonly<{
      operation: TfIntegrationOperation;
      errorCode: TfIntegrationsErrorCode;
    }>,
    message: "TF integrations command failed",
  ): void;
}

export const noopIntegrationsLogger: IntegrationsLogger = Object.freeze({
  error() {},
});

export function createConsoleIntegrationsLogger(): IntegrationsLogger {
  return Object.freeze({
    error(
      event: Parameters<IntegrationsLogger["error"]>[0],
      message: Parameters<IntegrationsLogger["error"]>[1],
    ) {
      console.error(message, event);
    },
  });
}
