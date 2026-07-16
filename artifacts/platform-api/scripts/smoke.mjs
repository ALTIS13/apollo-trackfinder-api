import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import assert from "node:assert/strict";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const composeFile = fileURLToPath(
  new URL("../docker-compose.yml", import.meta.url),
);
const INVITATION_MODULE_KEY = "tf.integrations";
const POLICY_MODULE_KEY = "tf.search";
let smokeStage = "startup";

function generatedSecret(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function configuredEnvironment() {
  const environment = { ...process.env };
  const defaultValue = (name, create) => {
    if ((environment[name] ?? "").trim().length === 0) {
      environment[name] = create();
    }
  };
  defaultValue(
    "COMPOSE_PROJECT_NAME",
    () =>
      `apollo-platform-smoke-${process.pid}-${randomBytes(4).toString("hex")}`,
  );
  defaultValue("PLATFORM_API_PORT", () => "8081");
  defaultValue(
    "PLATFORM_ALLOWED_ORIGINS",
    () => `http://127.0.0.1:${environment.PLATFORM_API_PORT}`,
  );
  defaultValue("PLATFORM_POSTGRES_ADMIN_PASSWORD", generatedSecret);
  defaultValue("PLATFORM_MIGRATOR_PASSWORD", generatedSecret);
  defaultValue("PLATFORM_RUNTIME_PASSWORD", generatedSecret);
  defaultValue("PLATFORM_OPERATOR_BOOTSTRAP_TOKEN", generatedSecret);
  defaultValue("PLATFORM_SMOKE_SESSION_TOKEN", generatedSecret);
  defaultValue(
    "PLATFORM_MIGRATOR_DATABASE_URL",
    () =>
      `postgres://apollo_platform_migrator:${encodeURIComponent(environment.PLATFORM_MIGRATOR_PASSWORD)}` +
      "@platform-postgres:5432/apollo_platform",
  );
  defaultValue(
    "PLATFORM_RUNTIME_DATABASE_URL",
    () =>
      `postgres://apollo_platform_runtime:${encodeURIComponent(environment.PLATFORM_RUNTIME_PASSWORD)}` +
      "@platform-postgres:5432/apollo_platform",
  );
  environment.PLATFORM_NODE_ENV = "development";
  environment.PLATFORM_DEVELOPMENT_TOKEN_ECHO = "true";
  return environment;
}

async function prepareSecretDirectory(environment) {
  if ((environment.PLATFORM_SECRET_DIRECTORY ?? "").trim().length > 0) {
    return undefined;
  }

  const directory = await mkdtemp(join(tmpdir(), "apollo-platform-secrets-"));
  try {
    await chmod(directory, 0o700);
    await Promise.all(
      [
        [
          "platform_migrator_database_url",
          environment.PLATFORM_MIGRATOR_DATABASE_URL,
        ],
        [
          "platform_runtime_database_url",
          environment.PLATFORM_RUNTIME_DATABASE_URL,
        ],
        [
          "platform_operator_bootstrap_token",
          environment.PLATFORM_OPERATOR_BOOTSTRAP_TOKEN,
        ],
        [
          "platform_smoke_session_token",
          environment.PLATFORM_SMOKE_SESSION_TOKEN,
        ],
      ].map(([name, value]) =>
        writeFile(join(directory, name), value, { mode: 0o600 }),
      ),
    );
    environment.PLATFORM_SECRET_DIRECTORY = directory;
    return directory;
  } catch (error) {
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertSecretFree(text, secrets, label) {
  for (const secret of secrets) {
    assert(!text.includes(secret), `${label} contains a raw secret`);
    assert(!text.includes(digest(secret)), `${label} contains a secret digest`);
  }
}

async function compose(environment, args, options = {}) {
  return execFileAsync("docker", ["compose", "-f", composeFile, ...args], {
    cwd: repositoryRoot,
    env: environment,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
}

async function waitForReady(baseUrl) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/readyz`);
      if (response.ok) return;
    } catch {
      // The API may still be starting; retry until the bounded deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Platform API readiness deadline exceeded");
}

function cookieValues(response) {
  const headers = response.headers;
  const values =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : (headers.get("set-cookie") ?? "").split(/,(?=\s*__Host-)/);
  return values.filter(Boolean);
}

async function jsonRequest(state, path, options = {}) {
  const requestId = randomUUID();
  const headers = {
    Origin: state.origin,
    "X-Request-ID": requestId,
    ...options.headers,
  };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(`${state.baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  const body = text.length === 0 ? null : JSON.parse(text);

  assert.equal(response.status, options.status ?? 200, `${path} status`);
  assert.equal(response.headers.get("x-request-id"), requestId);
  if (path.startsWith("/v1/")) {
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  state.projections.push({ path, body });
  return { response, body, text };
}

function protectedHeaders(state) {
  return {
    Cookie: state.cookies,
    "X-CSRF-Token": state.csrfToken,
  };
}

async function policyRun(environment, mode, accountId, sessionId) {
  const args = [
    "--profile",
    "smoke",
    "run",
    "--rm",
    "-e",
    `PLATFORM_SMOKE_MODE=${mode}`,
    "-e",
    `PLATFORM_SMOKE_ACCOUNT_ID=${accountId}`,
  ];
  if (sessionId !== undefined) {
    args.push("-e", `PLATFORM_SMOKE_SESSION_ID=${sessionId}`);
  }
  args.push("platform-smoke");
  const { stdout, stderr } = await compose(environment, args);
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  const result = JSON.parse(lines.at(-1));
  return { result, output: `${stdout}\n${stderr}` };
}

async function runSmoke(environment) {
  const baseUrl = `http://127.0.0.1:${environment.PLATFORM_API_PORT}`;
  const state = {
    baseUrl,
    origin: environment.PLATFORM_ALLOWED_ORIGINS,
    projections: [],
    cookies: "",
    csrfToken: "",
  };
  const operatorEmail = `operator-${randomUUID()}@example.test`;
  const memberEmail = `member-${randomUUID()}@example.test`;
  const operatorPassword = generatedSecret();
  const memberPassword = generatedSecret();
  const rawSecrets = [
    environment.PLATFORM_POSTGRES_ADMIN_PASSWORD,
    environment.PLATFORM_MIGRATOR_PASSWORD,
    environment.PLATFORM_RUNTIME_PASSWORD,
    environment.PLATFORM_OPERATOR_BOOTSTRAP_TOKEN,
    environment.PLATFORM_SMOKE_SESSION_TOKEN,
    environment.PLATFORM_MIGRATOR_DATABASE_URL,
    environment.PLATFORM_RUNTIME_DATABASE_URL,
    operatorPassword,
    memberPassword,
  ];

  smokeStage = "registration-closed";
  const registration = await jsonRequest(state, "/v1/registration");
  assert.deepEqual(registration.body, { mode: "closed" });

  smokeStage = "operator-bootstrap";
  await jsonRequest(state, "/v1/operator/bootstrap", {
    method: "POST",
    status: 201,
    body: {
      bootstrapToken: environment.PLATFORM_OPERATOR_BOOTSTRAP_TOKEN,
      email: operatorEmail,
      displayName: "Smoke Operator",
      password: operatorPassword,
      reason: "Task 8 local smoke bootstrap",
    },
  });

  smokeStage = "operator-login";
  const login = await jsonRequest(state, "/v1/operator/sessions", {
    method: "POST",
    body: { email: operatorEmail, password: operatorPassword },
  });
  const setCookies = cookieValues(login.response);
  assert.equal(setCookies.length, 2);
  assert(setCookies.every((value) => value.includes("Secure")));
  assert(setCookies.every((value) => value.includes("SameSite=Lax")));
  assert(setCookies.every((value) => !value.includes("Domain=")));
  const cookiePairs = setCookies.map((value) => value.split(";", 1)[0]);
  const cookieSecrets = Object.fromEntries(
    cookiePairs.map((value) => {
      const separator = value.indexOf("=");
      return [value.slice(0, separator), value.slice(separator + 1)];
    }),
  );
  state.cookies = cookiePairs.join("; ");
  state.csrfToken = login.body.csrfToken;
  assert(state.cookies.includes(`__Host-apollo_admin_csrf=${state.csrfToken}`));
  assert.equal(cookieSecrets["__Host-apollo_admin_csrf"], state.csrfToken);
  assert.equal(typeof cookieSecrets["__Host-apollo_admin"], "string");
  rawSecrets.push(
    cookieSecrets["__Host-apollo_admin"],
    cookieSecrets["__Host-apollo_admin_csrf"],
  );

  smokeStage = "registration-mode";
  await jsonRequest(state, "/v1/operator/registration-settings", {
    method: "PATCH",
    headers: protectedHeaders(state),
    body: { mode: "invite_only", reason: "Task 8 invitation smoke" },
  });

  smokeStage = "invitation-create";
  const invitation = await jsonRequest(state, "/v1/operator/invitations", {
    method: "POST",
    status: 201,
    headers: protectedHeaders(state),
    body: {
      email: memberEmail,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      usesLimit: 1,
      moduleKeys: [INVITATION_MODULE_KEY],
      reason: "Task 8 invitation",
    },
  });
  const invitationToken = invitation.body.invitationToken;
  assert.equal(typeof invitationToken, "string");
  assert.equal(
    invitation.text.split(invitationToken).length - 1,
    1,
    "invitation token is returned exactly once",
  );
  rawSecrets.push(invitationToken);

  smokeStage = "invitation-redeem";
  const registered = await jsonRequest(state, "/v1/registrations", {
    method: "POST",
    status: 202,
    body: {
      email: memberEmail,
      displayName: "Smoke Member",
      password: memberPassword,
      invitationToken,
    },
  });
  const accountId = registered.body.account.id;
  const verificationToken = registered.body.verificationToken;
  assert.equal(typeof verificationToken, "string");
  assert.equal(registered.body.account.email, undefined);
  rawSecrets.push(verificationToken);

  smokeStage = "verification-consume";
  await jsonRequest(state, "/v1/email-verifications/consume", {
    method: "POST",
    body: { token: verificationToken },
  });
  smokeStage = "verification-reconsume";
  const consumedAgain = await jsonRequest(
    state,
    "/v1/email-verifications/consume",
    {
      method: "POST",
      status: 409,
      body: { token: verificationToken },
    },
  );
  assert.equal(consumedAgain.body.error, "registration_not_available");

  smokeStage = "invitation-entitlement-revoke";
  await jsonRequest(
    state,
    `/v1/operator/accounts/${accountId}/entitlements/${INVITATION_MODULE_KEY}`,
    {
      method: "DELETE",
      headers: protectedHeaders(state),
      body: { reason: "Remove invitation grant before activation check" },
    },
  );

  smokeStage = "activation-without-entitlement";
  const activationWithoutEntitlement = await jsonRequest(
    state,
    `/v1/operator/accounts/${accountId}/activate`,
    {
      method: "POST",
      status: 409,
      headers: protectedHeaders(state),
      body: { reason: "Must require entitlement" },
    },
  );
  assert.equal(
    activationWithoutEntitlement.body.error,
    "registration_not_available",
  );

  smokeStage = "entitlement-grant";
  await jsonRequest(
    state,
    `/v1/operator/accounts/${accountId}/entitlements/${POLICY_MODULE_KEY}`,
    {
      method: "PUT",
      headers: protectedHeaders(state),
      body: { reason: "Task 8 grant" },
    },
  );
  smokeStage = "account-activate";
  const activated = await jsonRequest(
    state,
    `/v1/operator/accounts/${accountId}/activate`,
    {
      method: "POST",
      headers: protectedHeaders(state),
      body: { reason: "Task 8 activation" },
    },
  );
  assert.equal(activated.body.account.status, "active");

  smokeStage = "policy-allow";
  const allow = await policyRun(environment, "create", accountId);
  assert.deepEqual(allow.result.decision, { allowed: true });
  const sessionId = allow.result.sessionId;

  smokeStage = "entitlement-revoke";
  await jsonRequest(
    state,
    `/v1/operator/accounts/${accountId}/entitlements/${POLICY_MODULE_KEY}`,
    {
      method: "DELETE",
      headers: protectedHeaders(state),
      body: { reason: "Task 8 revoke" },
    },
  );
  smokeStage = "policy-deny";
  const deny = await policyRun(environment, "evaluate", accountId, sessionId);
  assert.deepEqual(deny.result.decision, {
    allowed: false,
    code: "module_access_denied",
    missingModuleKeys: [POLICY_MODULE_KEY],
  });

  smokeStage = "secret-scan";
  const { stdout: logs, stderr: logErrors } = await compose(environment, [
    "logs",
    "--no-color",
    "platform-api",
    "platform-migrate",
    "platform-postgres",
    "platform-redis",
  ]);
  assertSecretFree(`${logs}\n${logErrors}`, rawSecrets, "container logs");
  assertSecretFree(
    `${allow.output}\n${deny.output}`,
    rawSecrets,
    "policy-smoke output",
  );

  for (const projection of state.projections) {
    const redacted = structuredClone(projection.body);
    if (projection.path === "/v1/operator/invitations" && redacted !== null) {
      delete redacted.invitationToken;
    }
    if (projection.path === "/v1/registrations" && redacted !== null) {
      delete redacted.verificationToken;
    }
    if (projection.path === "/v1/operator/sessions" && redacted !== null) {
      delete redacted.csrfToken;
    }
    assertSecretFree(
      JSON.stringify(redacted),
      rawSecrets,
      `public projection ${projection.path}`,
    );
  }
}

async function main() {
  const environment = configuredEnvironment();
  const ownedSecretDirectory = await prepareSecretDirectory(environment);
  const secrets = [
    environment.PLATFORM_POSTGRES_ADMIN_PASSWORD,
    environment.PLATFORM_MIGRATOR_PASSWORD,
    environment.PLATFORM_RUNTIME_PASSWORD,
    environment.PLATFORM_OPERATOR_BOOTSTRAP_TOKEN,
    environment.PLATFORM_SMOKE_SESSION_TOKEN,
    environment.PLATFORM_MIGRATOR_DATABASE_URL,
    environment.PLATFORM_RUNTIME_DATABASE_URL,
  ];
  let failure;

  try {
    smokeStage = "compose-config";
    const configured = await compose(environment, ["config"]);
    assertSecretFree(
      `${configured.stdout}\n${configured.stderr}`,
      secrets,
      "Compose config",
    );
    const running = await compose(environment, ["ps", "-q", "platform-api"]);
    if (running.stdout.trim().length === 0) {
      smokeStage = "compose-up";
      await compose(environment, ["up", "-d", "--build", "--wait"]);
    }
    smokeStage = "readiness";
    await waitForReady(`http://127.0.0.1:${environment.PLATFORM_API_PORT}`);
    await runSmoke(environment);
    process.stdout.write(
      "Platform smoke passed: closed, bootstrap, login, invite, verify, grant, activate, allow, revoke, deny\n",
    );
  } catch (error) {
    failure = error;
  } finally {
    try {
      await compose(environment, ["down", "-v", "--remove-orphans"]);
    } catch (cleanupError) {
      if (failure === undefined) failure = cleanupError;
      else process.stderr.write("Platform smoke cleanup also failed\n");
    }
    if (ownedSecretDirectory !== undefined) {
      try {
        await rm(ownedSecretDirectory, { force: true, recursive: true });
      } catch (cleanupError) {
        if (failure === undefined) failure = cleanupError;
        else
          process.stderr.write("Platform smoke secret cleanup also failed\n");
      }
    }
  }

  if (failure !== undefined) throw failure;
}

void main().catch(() => {
  process.stderr.write(`Platform smoke failed at ${smokeStage}\n`);
  process.exitCode = 1;
});
