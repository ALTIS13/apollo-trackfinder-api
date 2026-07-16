import { z } from "zod";
import type { Router } from "express";

import { createRegistrationRequestSchema } from "@workspace/platform-contract";

import { rateLimitedError, validationError } from "../http/errors.js";
import type { RateLimiter } from "../http/rate-limit.js";
import type { InvitationService } from "../domain/invitations.js";
import type { RegistrationService } from "../domain/registration.js";

const consumeVerificationSchema = z
  .object({ token: z.string().min(1) })
  .strict();

export interface PublicRegistrationDependencies {
  readonly registration: Pick<
    RegistrationService,
    "getStatus" | "register" | "consumeVerificationToken"
  >;
  readonly invitations: Pick<InvitationService, "redeem">;
  readonly rateLimiter: RateLimiter;
  readonly developmentTokenEcho: boolean;
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw validationError();
  return parsed.data;
}

function publicAccount(account: {
  readonly id: string;
  readonly displayName: string;
  readonly status: string;
  readonly emailVerifiedAt: Date | null;
  readonly activatedAt: Date | null;
  readonly suspendedAt: Date | null;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}) {
  return {
    id: account.id,
    displayName: account.displayName,
    status: account.status,
    emailVerifiedAt: account.emailVerifiedAt?.toISOString() ?? null,
    activatedAt: account.activatedAt?.toISOString() ?? null,
    suspendedAt: account.suspendedAt?.toISOString() ?? null,
    deletedAt: account.deletedAt?.toISOString() ?? null,
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
  };
}

async function enforceRateLimit(
  rateLimiter: RateLimiter,
  bucket: string,
  ip: string,
  identity: string,
): Promise<void> {
  const result = await rateLimiter.consume({ bucket, ip, identity });
  if (!result.allowed) throw rateLimitedError(result.retryAfterSeconds);
}

export function registerPublicRegistrationRoutes(
  router: Router,
  dependencies: PublicRegistrationDependencies,
): void {
  router.get("/v1/registration", async (_request, response, next) => {
    try {
      response.json(await dependencies.registration.getStatus());
    } catch (error) {
      next(error);
    }
  });

  router.post("/v1/registrations", async (request, response, next) => {
    try {
      const input = parseBody(createRegistrationRequestSchema, request.body);
      const email = input.email;
      if (typeof email !== "string") throw validationError();
      await enforceRateLimit(
        dependencies.rateLimiter,
        input.invitationToken === undefined
          ? "registration"
          : "invitation-redemption",
        request.ip ?? "unavailable",
        email,
      );
      const context = { correlationId: String(response.locals.requestId) };
      const { invitationToken, ...registrationInput } = input;
      const result =
        invitationToken === undefined
          ? await dependencies.registration.register(input, context)
          : await dependencies.invitations.redeem(
              { ...registrationInput, invitationToken },
              context,
            );
      const body: Record<string, unknown> = {
        account: publicAccount(result.account),
      };
      if (dependencies.developmentTokenEcho) {
        body.verificationToken = result.verificationToken;
      }
      response.status(202).json(body);
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/v1/email-verifications/consume",
    async (request, response, next) => {
      try {
        const input = parseBody(consumeVerificationSchema, request.body);
        const token = input.token;
        if (typeof token !== "string") throw validationError();
        await enforceRateLimit(
          dependencies.rateLimiter,
          "verification",
          request.ip ?? "unavailable",
          token,
        );
        const account =
          await dependencies.registration.consumeVerificationToken(token, {
            correlationId: String(response.locals.requestId),
          });
        response.json({ account: publicAccount(account) });
      } catch (error) {
        next(error);
      }
    },
  );
}

export { publicAccount };
