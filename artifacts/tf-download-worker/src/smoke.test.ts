import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const artifactRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(artifactRoot, "../..");
const rootComposePath = path.join(repositoryRoot, "docker-compose.yml");
const smokeEntrypoint = path.join(
  artifactRoot,
  "scripts/start-smoke-worker.sh",
);
const ADMIN_TOKEN = "task-7-download-smoke-admin";
const WEB_ORIGIN_HOST = "127.0.0.1";

function shellPath(value: string): string {
  if (process.platform !== "win32") return value;
  const match = /^([A-Za-z]):\\(.*)$/.exec(value);
  if (match === null) return value.replaceAll("\\", "/");
  return `/${match[1]!.toLowerCase()}/${match[2]!.replaceAll("\\", "/")}`;
}

interface SmokeResult {
  readonly project: string;
  readonly observations: {
    readonly apiHealthy: boolean;
    readonly queueHealthy: boolean;
    readonly workerHealthy: boolean;
    readonly heartbeatHealthy: boolean;
    readonly heartbeatUnknownAfterReset: boolean;
    readonly heartbeatRecovered: boolean;
    readonly completedOwnedFixture: boolean;
    readonly authenticatedBytes: boolean;
    readonly statusAndProgress: boolean;
    readonly fullFile: boolean;
    readonly exactRange: boolean;
    readonly replayRejected: boolean;
    readonly tamperRejected: boolean;
    readonly wrongKeyRejected: boolean;
    readonly foreignOwnerRejected: boolean;
    readonly waitingCancellationClean: boolean;
    readonly activeCancellationClean: boolean;
    readonly sizeFailureBounded: boolean;
    readonly deadlineFailureBounded: boolean;
    readonly quotaFailureBounded: boolean;
    readonly noForbiddenInspectSurface: boolean;
    readonly canarySurfacesScanned: number;
    readonly noPublishedWorkerOrQueuePorts: boolean;
  };
  readonly cleanup: {
    readonly containers: number;
    readonly images: number;
    readonly networks: number;
    readonly temporaryDirectories: number;
    readonly volumes: number;
  };
}

interface DockerResult {
  readonly stdout: string;
  readonly stderr: string;
}

interface SessionFixture {
  readonly accountId: string;
  readonly csrf: string;
  readonly handle: string;
}

function generatedSecret(): string {
  return randomBytes(32).toString("base64url");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, WEB_ORIGIN_HOST, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve smoke API port");
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function docker(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  timeout = 300_000,
): Promise<DockerResult> {
  return execute("docker", [...args], {
    cwd: repositoryRoot,
    env: environment,
    maxBuffer: 16 * 1024 * 1024,
    timeout,
    windowsHide: true,
  });
}

function assertCondition(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function waitFor<T>(
  name: string,
  probe: () => Promise<T | false>,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== false) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `${name} deadline exceeded${lastError instanceof Error ? `: ${lastError.name}` : ""}`,
  );
}

async function fetchJson(
  url: string,
  init: RequestInit = {},
): Promise<{
  readonly response: Response;
  readonly body: Record<string, unknown> | null;
  readonly text: string;
}> {
  const response = await fetch(url, { redirect: "error", ...init });
  const text = await response.text();
  let body: Record<string, unknown> | null = null;
  try {
    body =
      text.length === 0 ? null : (JSON.parse(text) as Record<string, unknown>);
  } catch {
    body = null;
  }
  return { response, body, text };
}

function sessionHeaders(
  session: SessionFixture,
  origin: string,
  mutation = false,
): Record<string, string> {
  return {
    cookie:
      `__Host-apollo_tf=${session.handle}; ` +
      `__Host-apollo_tf_csrf=${session.csrf}`,
    ...(mutation ? { origin, "x-csrf-token": session.csrf } : {}),
  };
}

function trackIdFor(mode: string, sourceCanary: string): string {
  const url =
    `https://youtube.com/watch?v=fixture-${mode}` +
    `&mode=${mode}&source=${sourceCanary}`;
  return `yt_${Buffer.from(url).toString("base64url")}`;
}

async function runDisposableSmoke(): Promise<SmokeResult> {
  const project =
    `apollo-tf-download-smoke-${process.pid}-` + randomBytes(4).toString("hex");
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), `${project}-`));
  const secretDirectory = path.join(temporaryDirectory, "secrets");
  const overridePath = path.join(temporaryDirectory, "smoke.compose.yml");
  const port = await reservePort();
  const origin = `http://${WEB_ORIGIN_HOST}:${port}`;
  const queuePassword = generatedSecret();
  const commandSecret = generatedSecret();
  const heartbeatSecret = generatedSecret();
  const searchSecret = generatedSecret();
  const integrationsSecret = generatedSecret();
  const clientSecret = generatedSecret();
  const databasePassword = generatedSecret();
  const sourceCanary = `source-${generatedSecret()}`;
  const accountCanary = randomUUID();
  const signatureCanary = `signature-${generatedSecret()}`;
  const pathCanary = `path-${generatedSecret()}`;
  const stderrCanary = `stderr-${generatedSecret()}`;
  const canaries = [
    queuePassword,
    commandSecret,
    heartbeatSecret,
    searchSecret,
    integrationsSecret,
    clientSecret,
    databasePassword,
    sourceCanary,
    accountCanary,
    signatureCanary,
    pathCanary,
    stderrCanary,
  ];
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    TF_SECRET_DIRECTORY: secretDirectory,
    TF_API_PORT: String(port),
    TF_DOWNLOAD_REDIS_IMAGE: `${project}-redis:local`,
    TF_DOWNLOAD_WORKER_IMAGE: `${project}-worker:local`,
    ADMIN_DASHBOARD_TOKEN: ADMIN_TOKEN,
  };
  const composeBase = [
    "compose",
    "-f",
    rootComposePath,
    "-f",
    overridePath,
    "-p",
    project,
  ] as const;
  const compose = (
    args: readonly string[],
    timeout?: number,
  ): Promise<DockerResult> =>
    docker([...composeBase, ...args], environment, timeout);
  const responseSurfaces: string[] = [];
  let logs = "";
  let primaryError: unknown;
  let result: SmokeResult | undefined;

  try {
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(secretDirectory, { recursive: true, mode: 0o700 }),
    );
    const secrets: Record<string, string> = {
      tf_postgres_password: databasePassword,
      tf_database_url:
        `postgres://trackfinder:${encodeURIComponent(databasePassword)}` +
        "@db:5432/trackfinder",
      tf_client_secret: clientSecret,
      tf_search_internal_auth_secret: searchSecret,
      tf_integrations_internal_auth_secret: integrationsSecret,
      tf_download_queue_password: queuePassword,
      tf_download_queue_redis_url:
        `redis://default:${encodeURIComponent(queuePassword)}` +
        "@tf-download-redis:6379/0",
      tf_download_internal_auth_secret: commandSecret,
      tf_download_heartbeat_secret: heartbeatSecret,
      tf_module_heartbeat_keys: JSON.stringify({
        "search-media": generatedSecret(),
        "account-integrations": generatedSecret(),
        "download-worker": heartbeatSecret,
      }),
    };
    for (const [name, value] of Object.entries(secrets)) {
      const filePath = path.join(secretDirectory, name);
      await writeFile(filePath, value, { encoding: "utf8", mode: 0o400 });
      if (process.platform !== "win32") await chmod(filePath, 0o400);
    }
    if (process.platform !== "win32") await chmod(secretDirectory, 0o700);

    await writeFile(
      overridePath,
      [
        "services:",
        "  api:",
        "    environment:",
        `      ADMIN_DASHBOARD_TOKEN: ${ADMIN_TOKEN}`,
        "      NODE_ENV: development",
        "      APOLLO_PLATFORM_API_ORIGIN: http://platform-api:8080",
        `      APOLLO_PLATFORM_ISSUER: ${origin}`,
        '      APOLLO_TF_BRIDGE_ALLOW_INTERNAL_HTTP: "true"',
        `      APOLLO_TF_CALLBACK_URL: ${origin}/api/auth/callback`,
        `      APOLLO_TF_WEB_ORIGIN: ${origin}`,
        `      SERVER_URL: ${origin}`,
        "    depends_on:",
        "      tf-integrations: !reset null",
        "      tf-search: !reset null",
        "      platform-api:",
        "        condition: service_started",
        "  platform-api:",
        "    image: node:20-bookworm-slim",
        "    command:",
        "      - node",
        "      - -e",
        "      - >-",
        "        const http=require('node:http');",
        "        http.createServer((req,res)=>{",
        "        if(req.method!=='POST'||req.url!=='/v1/oauth/introspect'){res.writeHead(404).end();return}",
        "        const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{try{",
        "        const body=JSON.parse(Buffer.concat(chunks));",
        "        const out=JSON.stringify({active:true,accountId:body.accountId,sessionId:body.sessionId,installationId:body.installationId,accountStatus:'active',entitlements:['tf.downloads'],expiresAt:new Date(Date.now()+1800000).toISOString()});",
        "        res.writeHead(200,{'content-type':'application/json','content-length':Buffer.byteLength(out)});res.end(out)",
        "        }catch{res.writeHead(400).end()}})}).listen(8080,'0.0.0.0')",
        "    init: true",
        "    read_only: true",
        "    tmpfs:",
        "      - /tmp:rw,noexec,nosuid,size=16m",
        "    networks:",
        "      - tf-edge",
        "    security_opt:",
        "      - no-new-privileges:true",
        "    cap_drop:",
        "      - ALL",
        "    pids_limit: 64",
        "  tf-download-worker:",
        "    build:",
        "      target: smoke-runtime",
        "    environment:",
        "      NODE_ENV: test",
        '      TF_DOWNLOAD_SMOKE_FIXTURES: "true"',
        '      TF_DOWNLOAD_MAX_FILE_BYTES: "1024"',
        '      TF_DOWNLOAD_STORAGE_QUOTA_BYTES: "1536"',
        '      TF_DOWNLOAD_SWEEP_INTERVAL_MS: "1000"',
        "",
      ].join("\n"),
      "utf8",
    );

    const rendered = await compose(["config"]);
    for (const canary of canaries) {
      assertCondition(
        !`${rendered.stdout}\n${rendered.stderr}`.includes(canary),
        "rendered Compose exposed a canary",
      );
    }

    await compose(
      [
        "up",
        "-d",
        "--build",
        "--wait",
        "--wait-timeout",
        "300",
        "db",
        "redis",
        "tf-download-redis",
        "tf-download-worker",
        "platform-api",
        "api",
      ],
      15 * 60_000,
    );

    const inspectIds = (
      await compose([
        "ps",
        "-q",
        "api",
        "tf-download-redis",
        "tf-download-worker",
      ])
    ).stdout
      .split(/\r?\n/)
      .filter(Boolean);
    assertCondition(inspectIds.length === 3, "smoke services were not created");
    const inspection = (await docker(["inspect", ...inspectIds], environment))
      .stdout;
    const inspected = JSON.parse(inspection) as Array<{
      readonly Config?: {
        readonly Env?: readonly string[];
        readonly Labels?: Record<string, string>;
      };
      readonly HostConfig?: {
        readonly Binds?: readonly string[] | null;
        readonly PortBindings?: Record<string, unknown>;
      };
      readonly Mounts?: readonly {
        readonly Destination?: string;
        readonly Source?: string;
      }[];
      readonly NetworkSettings?: {
        readonly Networks?: Record<string, unknown>;
      };
      readonly State?: {
        readonly Health?: { readonly Status?: string };
      };
    }>;
    const byService = new Map(
      inspected.map((container) => [
        container.Config?.Labels?.["com.docker.compose.service"],
        container,
      ]),
    );
    const queueHealthy =
      byService.get("tf-download-redis")?.State?.Health?.Status === "healthy";
    const workerHealthy =
      byService.get("tf-download-worker")?.State?.Health?.Status === "healthy";
    const noPublishedWorkerOrQueuePorts = [
      "tf-download-redis",
      "tf-download-worker",
    ].every(
      (name) =>
        Object.keys(byService.get(name)?.HostConfig?.PortBindings ?? {})
          .length === 0,
    );
    assertCondition(queueHealthy, "queue Redis was not healthy");
    assertCondition(workerHealthy, "worker was not healthy");

    const apiHealthy = await waitFor("TF API health", async () => {
      const response = await fetch(`${origin}/api/readyz`);
      return response.ok;
    });

    const dashboardModule = async (
      expected: "healthy" | "unknown",
      timeoutMs = 45_000,
    ): Promise<Record<string, unknown>> =>
      waitFor(
        `download-worker heartbeat ${expected}`,
        async () => {
          const probe = await fetchJson(`${origin}/api/admin/dashboard`, {
            headers: { "x-admin-dashboard-token": ADMIN_TOKEN },
          });
          const modules = probe.body?.["modules"];
          if (!probe.response.ok || !Array.isArray(modules)) return false;
          const module = modules.find(
            (candidate) =>
              typeof candidate === "object" &&
              candidate !== null &&
              (candidate as Record<string, unknown>)["id"] ===
                "download-worker",
          ) as Record<string, unknown> | undefined;
          return module?.["status"] === expected ? module : false;
        },
        timeoutMs,
      );

    const heartbeat = await dashboardModule("healthy");
    await compose(["restart", "api"]);
    await waitFor("TF API health after reset", async () => {
      const response = await fetch(`${origin}/api/readyz`);
      return response.ok;
    });
    const unknown = await dashboardModule("unknown", 10_000);
    const recovered = await dashboardModule("healthy", 45_000);

    const seedSession = async (
      forcedAccountId?: string,
    ): Promise<SessionFixture> => {
      const handle = generatedSecret();
      const csrf = generatedSecret();
      const revision = generatedSecret();
      const accountId = forcedAccountId ?? randomUUID();
      const now = Date.now();
      const stored = JSON.stringify({
        revision,
        session: {
          id: randomUUID(),
          accountId,
          platformSessionId: randomUUID(),
          installationId: randomUUID(),
          entitlements: ["tf.downloads"],
          assertionExpiresAt: new Date(now + 1_000).toISOString(),
          expiresAt: new Date(now + 30 * 60_000).toISOString(),
        },
      });
      await compose([
        "exec",
        "-T",
        "redis",
        "redis-cli",
        "-n",
        "1",
        "SET",
        `tf-auth:session:${digest(handle)}`,
        stored,
        "PX",
        String(30 * 60_000),
      ]);
      return { accountId, csrf, handle };
    };
    const owner = await seedSession(accountCanary);
    const foreign = await seedSession();

    const jobModes = new Map<string, string>();
    const enqueue = async (mode: string, session = owner): Promise<string> => {
      const probe = await fetchJson(`${origin}/api/tracks/download/queue`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...sessionHeaders(session, origin, true),
        },
        body: JSON.stringify({
          tracks: [
            {
              trackId: trackIdFor(mode, sourceCanary),
              artist: "Smoke Artist",
              title: `Smoke ${mode}`,
              quality: "320",
            },
          ],
        }),
      });
      responseSurfaces.push(probe.text);
      assertCondition(
        probe.response.status === 200,
        `enqueue failed (${probe.response.status} ${probe.text.slice(0, 128)})`,
      );
      const results = probe.body?.["results"];
      assertCondition(Array.isArray(results), "enqueue result missing");
      const jobId = (results[0] as Record<string, unknown>)["jobId"];
      assertCondition(typeof jobId === "string", "enqueue job id missing");
      jobModes.set(jobId, mode);
      return jobId;
    };
    const status = async (
      jobId: string,
      session = owner,
    ): Promise<Record<string, unknown> & { readonly status: string }> => {
      const probe = await fetchJson(
        `${origin}/api/tracks/download/status/${jobId}`,
        { headers: sessionHeaders(session, origin) },
      );
      responseSurfaces.push(probe.text);
      assertCondition(probe.response.status === 200, "status request failed");
      assertCondition(
        typeof probe.body?.["status"] === "string",
        "status body missing",
      );
      return probe.body as Record<string, unknown> & {
        readonly status: string;
      };
    };
    const waitForStatus = (
      jobId: string,
      expected: readonly string[],
    ): Promise<Record<string, unknown> & { readonly status: string }> =>
      waitFor(
        `${jobModes.get(jobId) ?? "unknown"} job ${expected.join("/")}`,
        async () => {
          const current = await status(jobId);
          return expected.includes(current.status) ? current : false;
        },
        60_000,
      );
    const cancel = async (jobId: string): Promise<string> => {
      const probe = await fetchJson(
        `${origin}/api/tracks/download/jobs/${jobId}`,
        {
          method: "DELETE",
          headers: sessionHeaders(owner, origin, true),
        },
      );
      responseSurfaces.push(probe.text);
      assertCondition(probe.response.status === 200, "cancel request failed");
      return String(probe.body?.["status"]);
    };

    const completedJob = await enqueue("normal");
    const completed = await waitForStatus(completedJob, ["completed"]);
    const full = await fetch(
      `${origin}/api/tracks/download/file/${completedJob}`,
      { headers: sessionHeaders(owner, origin) },
    );
    const fullBytes = Buffer.from(await full.arrayBuffer());
    responseSurfaces.push(fullBytes.toString("base64"));
    const ranged = await fetch(
      `${origin}/api/tracks/download/file/${completedJob}`,
      {
        headers: {
          ...sessionHeaders(owner, origin),
          range: "bytes=10-19",
        },
      },
    );
    const rangedBytes = Buffer.from(await ranged.arrayBuffer());
    responseSurfaces.push(rangedBytes.toString("base64"));
    const authenticatedBytes =
      full.status === 200 &&
      fullBytes.length === 600 &&
      fullBytes.every((value) => value === 65);
    const exactRange =
      ranged.status === 206 &&
      ranged.headers.get("content-range") === "bytes 10-19/600" &&
      rangedBytes.length === 10 &&
      rangedBytes.every((value) => value === 65);

    const signedProbeSource = String.raw`
const { createHash, createHmac, randomBytes, randomUUID } = require("node:crypto");
const { readFileSync } = require("node:fs");
const secret = readFileSync(process.env.TF_DOWNLOAD_INTERNAL_AUTH_SECRET_FILE, "utf8").trim();
const path = "/v1/files";
const body = JSON.stringify({schemaVersion:1,requestId:randomUUID(),accountId:process.env.ACCOUNT_ID,jobId:process.env.JOB_ID});
function signed(value, key = secret, nonce = randomBytes(32).toString("hex")) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", key).update(["POST",path,timestamp,nonce,createHash("sha256").update(value).digest("hex")].join("\n")).digest("hex");
  return {timestamp,nonce,signature};
}
async function send(value, headers) {
  const response = await fetch("http://127.0.0.1:8080" + path, {method:"POST",headers:{"content-type":"application/json","x-apollo-internal-timestamp":headers.timestamp,"x-apollo-internal-nonce":headers.nonce,"x-apollo-internal-signature":headers.signature},body:value});
  await response.arrayBuffer();
  return response.status;
}
async function main() {
const replayHeaders = signed(body);
const first = await send(body, replayHeaders);
const replay = await send(body, replayHeaders);
const tamperHeaders = signed(body);
const tamper = await send(body + " ", tamperHeaders);
const wrong = await send(body, signed(body, process.env.WRONG_KEY));
const foreignBody = JSON.stringify({...JSON.parse(body),requestId:randomUUID(),accountId:process.env.FOREIGN_ID});
const foreign = await send(foreignBody, signed(foreignBody));
process.stdout.write(JSON.stringify({first,replay,tamper,wrong,foreign}));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
`;
    const signedProbe = await compose([
      "exec",
      "-T",
      "-e",
      `ACCOUNT_ID=${owner.accountId}`,
      "-e",
      `FOREIGN_ID=${foreign.accountId}`,
      "-e",
      `JOB_ID=${completedJob}`,
      "-e",
      `WRONG_KEY=${signatureCanary}`,
      "tf-download-worker",
      "node",
      "-e",
      signedProbeSource,
    ]);
    const signedStatuses = JSON.parse(signedProbe.stdout) as Record<
      string,
      number
    >;

    const activeOne = await enqueue("active");
    const activeTwo = await enqueue("active");
    await Promise.all([
      waitForStatus(activeOne, ["active"]),
      waitForStatus(activeTwo, ["active"]),
    ]);
    const waiting = await enqueue("active");
    await waitForStatus(waiting, ["waiting"]);
    const waitingAccepted = await cancel(waiting);
    const activeAccepted = await cancel(activeOne);
    await cancel(activeTwo);
    await Promise.all([
      waitForStatus(waiting, ["canceled"]),
      waitForStatus(activeOne, ["canceled"]),
      waitForStatus(activeTwo, ["canceled"]),
    ]);
    const storageListing = await compose([
      "exec",
      "-T",
      "tf-download-worker",
      "node",
      "-e",
      "const{readdirSync}=require('node:fs');process.stdout.write(JSON.stringify(readdirSync(process.env.TF_DOWNLOAD_STORAGE_ROOT)))",
    ]);
    const storageFiles = JSON.parse(storageListing.stdout) as string[];
    const waitingCancellationClean =
      waitingAccepted === "waiting" &&
      !storageFiles.some((name) => name.startsWith(waiting));
    const activeCancellationClean =
      activeAccepted === "active" &&
      !storageFiles.some(
        (name) => name.startsWith(activeOne) || name.startsWith(activeTwo),
      );

    const sizeJob = await enqueue("size");
    await waitForStatus(sizeJob, ["failed"]);
    const quotaHoldJob = await enqueue("hold");
    await waitForStatus(quotaHoldJob, ["active"]);
    await waitFor("quota hold partial", async () => {
      const output = await compose([
        "exec",
        "-T",
        "-e",
        `HOLD_JOB_ID=${quotaHoldJob}`,
        "tf-download-worker",
        "node",
        "-e",
        "const{statSync}=require('node:fs');const p=process.env.TF_DOWNLOAD_STORAGE_ROOT+'/'+process.env.HOLD_JOB_ID+'.mp3.part';try{process.stdout.write(String(statSync(p).size))}catch{process.stdout.write('0')}",
      ]);
      return Number(output.stdout.trim()) === 900;
    });
    const quotaJob = await enqueue("quota");
    await waitForStatus(quotaJob, ["failed"]);
    await cancel(quotaHoldJob);
    await waitForStatus(quotaHoldJob, ["canceled"]);
    const deadlineJob = await enqueue("deadline");
    await waitForStatus(deadlineJob, ["failed"]);
    const failedReason = async (jobId: string): Promise<string> => {
      const output = await compose([
        "exec",
        "-T",
        "-e",
        `REDISCLI_AUTH=${queuePassword}`,
        "tf-download-redis",
        "redis-cli",
        "--no-auth-warning",
        "--raw",
        "HGET",
        `{apollo-tf-downloads}:apollo-tf-downloads-v1:${jobId}`,
        "failedReason",
      ]);
      return output.stdout.trim();
    };
    const [sizeReason, deadlineReason, quotaReason] = await Promise.all([
      failedReason(sizeJob),
      failedReason(deadlineJob),
      failedReason(quotaJob),
    ]);

    const foreignStatus = await fetch(
      `${origin}/api/tracks/download/status/${completedJob}`,
      { headers: sessionHeaders(foreign, origin) },
    );
    const foreignFile = await fetch(
      `${origin}/api/tracks/download/file/${completedJob}`,
      { headers: sessionHeaders(foreign, origin) },
    );
    responseSurfaces.push(await foreignStatus.text(), await foreignFile.text());

    logs = (await compose(["logs", "--no-color"])).stdout;
    const imageHistory = (
      await Promise.all(
        [
          `${project}-redis:local`,
          `${project}-worker:local`,
          `${project}-api`,
        ].map(async (image) =>
          docker(
            ["history", "--no-trunc", "--format", "{{json .}}", image],
            environment,
          ).then((value) => value.stdout),
        ),
      )
    ).join("\n");
    const trackedProjection = (
      await execute("git", ["grep", "-n", "-I", "-F", "--", sourceCanary], {
        cwd: repositoryRoot,
        windowsHide: true,
      }).catch(() => ({ stdout: "", stderr: "" }))
    ).stdout;
    const surfaces = [
      rendered.stdout,
      logs,
      responseSurfaces.join("\n"),
      inspection,
      imageHistory,
      trackedProjection,
    ];
    for (const surface of surfaces) {
      for (const canary of canaries) {
        assertCondition(
          !surface.includes(canary),
          "smoke surface exposed a canary",
        );
      }
    }
    const workerInspection = byService.get("tf-download-worker");
    const workerEnvironmentNames = (workerInspection?.Config?.Env ?? []).map(
      (entry) => entry.split("=", 1)[0] ?? "",
    );
    const workerMountSurface = [
      ...(workerInspection?.HostConfig?.Binds ?? []),
      ...(workerInspection?.Mounts ?? []).flatMap((mount) => [
        mount.Source ?? "",
        mount.Destination ?? "",
      ]),
    ];
    const workerNetworkNames = Object.keys(
      workerInspection?.NetworkSettings?.Networks ?? {},
    ).map((name) => name.replace(`${project}_`, ""));
    const noForbiddenInspectSurface =
      workerInspection !== undefined &&
      workerEnvironmentNames.every(
        (name) =>
          !/DATABASE|POSTGRES|PLATFORM|SPOTIFY|YANDEX|PROVIDER|DOCKER_HOST|COOLIFY|CADDY|SSH/i.test(
            name,
          ),
      ) &&
      workerMountSurface.every(
        (value) => !value.includes("/var/run/docker.sock"),
      ) &&
      new Set(workerNetworkNames).size === 3 &&
      ["tf-download-queue", "tf-download-control", "tf-download-egress"].every(
        (name) => workerNetworkNames.includes(name),
      );

    result = {
      project,
      observations: {
        apiHealthy,
        queueHealthy,
        workerHealthy,
        heartbeatHealthy: heartbeat["status"] === "healthy",
        heartbeatUnknownAfterReset: unknown["status"] === "unknown",
        heartbeatRecovered: recovered["status"] === "healthy",
        completedOwnedFixture: completed.status === "completed",
        authenticatedBytes,
        statusAndProgress:
          completed["progress"] === 100 && completed["fileSize"] === 600,
        fullFile: full.status === 200,
        exactRange,
        replayRejected:
          signedStatuses["first"] === 200 && signedStatuses["replay"] === 401,
        tamperRejected: signedStatuses["tamper"] === 401,
        wrongKeyRejected: signedStatuses["wrong"] === 401,
        foreignOwnerRejected:
          signedStatuses["foreign"] === 404 &&
          foreignStatus.status === 404 &&
          foreignFile.status === 404,
        waitingCancellationClean,
        activeCancellationClean,
        sizeFailureBounded: sizeReason === "output_too_large",
        deadlineFailureBounded: deadlineReason === "deadline_exceeded",
        quotaFailureBounded: quotaReason === "storage_quota_exceeded",
        noForbiddenInspectSurface,
        canarySurfacesScanned: surfaces.length,
        noPublishedWorkerOrQueuePorts,
      },
      cleanup: {
        containers: -1,
        images: -1,
        networks: -1,
        temporaryDirectories: -1,
        volumes: -1,
      },
    };
  } catch (error) {
    primaryError = error;
    try {
      const [
        projectLogs,
        workerLogs,
        apiLogs,
        platformLogs,
        projectState,
        workerProbe,
        apiProbe,
        platformProbe,
      ] = await Promise.all([
        compose(["logs", "--no-color"]),
        compose(["logs", "--no-color", "tf-download-worker"]),
        compose(["logs", "--no-color", "api"]),
        compose(["logs", "--no-color", "platform-api"]),
        compose(["ps", "-a", "--format", "json"]),
        compose([
          "exec",
          "-T",
          "tf-download-worker",
          "node",
          "-e",
          "Promise.all(['/healthz','/readyz'].map(async p=>[p,(await fetch('http://127.0.0.1:8080'+p)).status])).then(v=>process.stdout.write(JSON.stringify(v)))",
        ]).catch(() => ({ stdout: "worker probe unavailable", stderr: "" })),
        compose([
          "exec",
          "-T",
          "api",
          "node",
          "-e",
          "Promise.all(['/api/healthz','/api/readyz'].map(async p=>[p,(await fetch('http://127.0.0.1:8080'+p)).status])).then(v=>process.stdout.write(JSON.stringify(v)))",
        ]).catch(() => ({ stdout: "api probe unavailable", stderr: "" })),
        compose([
          "exec",
          "-T",
          "api",
          "node",
          "-e",
          "fetch('http://platform-api:8080/v1/oauth/introspect',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({accountId:'00000000-0000-4000-8000-000000000001',sessionId:'00000000-0000-4000-8000-000000000002',installationId:'00000000-0000-4000-8000-000000000003',audience:'apollo-tf'})}).then(async r=>process.stdout.write(JSON.stringify([r.status,await r.text()])))",
        ]).catch(() => ({ stdout: "platform probe unavailable", stderr: "" })),
      ]);
      logs = [
        projectLogs.stdout,
        projectState.stdout,
        workerProbe.stdout,
        apiProbe.stdout,
        platformProbe.stdout,
        apiLogs.stdout,
        platformLogs.stdout,
        platformProbe.stdout,
        workerLogs.stdout,
      ].join("\n");
    } catch {
      // Cleanup and residue audit remain authoritative.
    }
  } finally {
    try {
      await compose(
        ["down", "--remove-orphans", "--volumes", "--rmi", "local"],
        300_000,
      );
    } catch (error) {
      primaryError ??= error;
    }
    for (const image of [
      `${project}-redis:local`,
      `${project}-worker:local`,
      `${project}-api`,
    ]) {
      await docker(["image", "rm", "-f", image], environment).catch(
        () => undefined,
      );
    }
    await rm(temporaryDirectory, { force: true, recursive: true });

    const [containers, images, networks, volumes] = await Promise.all([
      docker(
        [
          "ps",
          "-aq",
          "--filter",
          `label=com.docker.compose.project=${project}`,
        ],
        environment,
      ),
      docker(
        ["images", "-q", "--filter", `reference=${project}-*`],
        environment,
      ),
      docker(
        ["network", "ls", "-q", "--filter", `name=^${project}_`],
        environment,
      ),
      docker(
        [
          "volume",
          "ls",
          "-q",
          "--filter",
          `label=com.docker.compose.project=${project}`,
        ],
        environment,
      ),
    ]);
    const count = (value: string): number =>
      value.split(/\r?\n/).filter(Boolean).length;
    const cleanup = {
      containers: count(containers.stdout),
      images: count(images.stdout),
      networks: count(networks.stdout),
      temporaryDirectories: 0,
      volumes: count(volumes.stdout),
    };
    if (result !== undefined) result = { ...result, cleanup };
    if (Object.values(cleanup).some((value) => value !== 0)) {
      primaryError ??= new Error("TF download smoke left owned residue");
    }
  }

  if (primaryError !== undefined) {
    const redactedLogs = canaries.reduce(
      (value, canary) => value.replaceAll(canary, "[REDACTED]"),
      logs.slice(-4_000),
    );
    throw new Error(
      `TF download Docker smoke failed: ${
        primaryError instanceof Error ? primaryError.message : "unknown"
      }${redactedLogs.length === 0 ? "" : `\n${redactedLogs}`}`,
    );
  }
  assertCondition(result !== undefined, "smoke result missing");
  return result;
}

describe("TF download smoke fixture gate", () => {
  it("rejects the fixture flag outside exact test mode", async () => {
    await expect(
      execute(
        "sh",
        [
          shellPath(smokeEntrypoint),
          "sh",
          "-c",
          "printf '%s' \"$TF_DOWNLOAD_YT_DLP_PATH\"",
        ],
        {
          env: {
            PATH: process.env.PATH,
            NODE_ENV: "production",
            TF_DOWNLOAD_SMOKE_FIXTURES: "true",
          },
          windowsHide: true,
        },
      ),
    ).rejects.toBeDefined();
  });

  it("activates fixtures only for exact test mode and exact true", async () => {
    const result = await execute(
      "sh",
      [
        shellPath(smokeEntrypoint),
        "sh",
        "-c",
        'printf \'%s|%s\' "$TF_DOWNLOAD_YT_DLP_PATH" "$NODE_OPTIONS"',
      ],
      {
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "test",
          TF_DOWNLOAD_SMOKE_FIXTURES: "true",
        },
        windowsHide: true,
      },
    );

    expect(result.stdout).toBe(
      "/app/bin/smoke-downloader.sh|--import=/app/bin/smoke-deadline.mjs",
    );
    expect(result.stderr).toBe("");
  });

  it("keeps the production image on its original entrypoint", async () => {
    const dockerfile = await readFile(
      path.join(artifactRoot, "Dockerfile"),
      "utf8",
    );

    expect(dockerfile).toContain("FROM runtime AS smoke-runtime");
    expect(dockerfile).toContain(
      'ENTRYPOINT ["/app/bin/start-smoke-worker.sh", "/app/bin/start-worker.sh"]',
    );
    expect(dockerfile).toContain(
      "COPY artifacts/tf-download-worker/scripts/smoke-deadline.mjs ./bin/smoke-deadline.mjs",
    );
    expect(dockerfile).toContain('CMD ["node", "/app/dist/index.mjs"]');
    expect(dockerfile).toContain("FROM runtime AS final");
    expect(dockerfile).toContain('ENTRYPOINT ["/app/bin/start-worker.sh"]');
  });
});

const realDockerEnabled = process.env.TF_DOWNLOAD_SMOKE_REAL_DOCKER === "1";

describe.skipIf(!realDockerEnabled)(
  "TF download disposable real Docker smoke",
  () => {
    it(
      "proves the private download stack and removes every owned resource",
      async () => {
        const result = await runDisposableSmoke();

        expect(result.project).toMatch(
          /^apollo-tf-download-smoke-\d+-[a-f0-9]{8}$/,
        );
        expect(result.observations).toEqual({
          apiHealthy: true,
          queueHealthy: true,
          workerHealthy: true,
          heartbeatHealthy: true,
          heartbeatUnknownAfterReset: true,
          heartbeatRecovered: true,
          completedOwnedFixture: true,
          authenticatedBytes: true,
          statusAndProgress: true,
          fullFile: true,
          exactRange: true,
          replayRejected: true,
          tamperRejected: true,
          wrongKeyRejected: true,
          foreignOwnerRejected: true,
          waitingCancellationClean: true,
          activeCancellationClean: true,
          sizeFailureBounded: true,
          deadlineFailureBounded: true,
          quotaFailureBounded: true,
          noForbiddenInspectSurface: true,
          canarySurfacesScanned: 6,
          noPublishedWorkerOrQueuePorts: true,
        });
        expect(result.cleanup).toEqual({
          containers: 0,
          images: 0,
          networks: 0,
          temporaryDirectories: 0,
          volumes: 0,
        });
      },
      20 * 60_000,
    );
  },
);
