import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const rootComposePath = join(repositoryRoot, "docker-compose.yml");
const nestedComposePath = join(
  repositoryRoot,
  "artifacts",
  "api-server",
  "docker-compose.yml",
);
const musicPlayerDirectory = join(repositoryRoot, "artifacts", "music-player");
const musicPlayerDockerfile = join(musicPlayerDirectory, "Dockerfile");
const modulesDocumentation = join(repositoryRoot, "MODULES.md");
const temporaryDirectories: string[] = [];

type ComposeService = {
  readonly build?: {
    readonly args?: Record<string, string>;
    readonly context?: string;
    readonly dockerfile?: string;
  };
  readonly depends_on?: Record<string, unknown>;
  readonly environment?: Record<string, string>;
  readonly networks?: readonly string[];
  readonly ports?: readonly string[];
  readonly secrets?: readonly string[];
  readonly volumes?: readonly string[];
};

type ComposeTemplate = {
  readonly name?: string;
  readonly services: Record<string, ComposeService>;
  readonly volumes?: Record<string, unknown>;
};

async function composeTemplate(path: string): Promise<ComposeTemplate> {
  return parse(await readFile(path, "utf8")) as ComposeTemplate;
}

function service(template: ComposeTemplate, name: string): ComposeService {
  const current = template.services[name];
  if (current === undefined) throw new Error(`missing service ${name}`);
  return current;
}

async function filesRecursively(directory: string): Promise<string[]> {
  const entries = await readdir(directory);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry);
    if ((await stat(path)).isDirectory()) {
      files.push(...(await filesRecursively(path)));
    } else {
      files.push(path);
    }
  }
  return files;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("TF deployment identity contract", () => {
  it("preserves the root base identities while retaining Task 9 hardening", async () => {
    const template = await composeTemplate(rootComposePath);

    expect(template.name).toBeUndefined();
    expect(Object.keys(template.services).sort()).toEqual([
      "admin",
      "api",
      "db",
      "redis",
      "web",
    ]);
    expect(Object.keys(template.volumes ?? {}).sort()).toEqual([
      "pgdata",
      "redis_data",
    ]);
    expect(service(template, "db").environment).toMatchObject({
      POSTGRES_DB: "trackfinder",
      POSTGRES_PASSWORD_FILE: "/run/secrets/tf_postgres_password",
      POSTGRES_USER: "trackfinder",
    });
    expect(service(template, "db").volumes).toContain(
      "pgdata:/var/lib/postgresql/data",
    );
    expect(service(template, "api").environment).toMatchObject({
      APOLLO_TF_AUTH_REDIS_URL: "redis://redis:6379/1",
      DATABASE_URL_FILE: "/run/secrets/tf_database_url",
      REDIS_URL: "redis://redis:6379/0",
    });
    expect(service(template, "api").environment).not.toHaveProperty(
      "DATABASE_URL",
    );
    expect(service(template, "api").ports).toEqual([
      "127.0.0.1:${TF_API_PORT:-8080}:8080",
    ]);
    expect(service(template, "db").ports).toBeUndefined();
    expect(service(template, "redis").ports).toBeUndefined();
    expect(service(template, "admin").environment).toMatchObject({
      APOLLO_API_UPSTREAM: "http://api:8080",
    });
    expect(JSON.stringify(template)).not.toMatch(/postgres:\/\/[^"]+:[^"]+@/);
  });

  it("preserves the nested API base identities and private data services", async () => {
    const template = await composeTemplate(nestedComposePath);

    expect(template.name).toBeUndefined();
    expect(Object.keys(template.services).sort()).toEqual([
      "api",
      "db",
      "redis",
    ]);
    expect(Object.keys(template.volumes ?? {}).sort()).toEqual([
      "postgres_data",
      "redis_data",
    ]);
    expect(service(template, "db").environment).toMatchObject({
      POSTGRES_DB: "apollo_trackfinder",
      POSTGRES_PASSWORD_FILE: "/run/secrets/tf_postgres_password",
      POSTGRES_USER: "apollo",
    });
    expect(service(template, "db").volumes).toContain(
      "postgres_data:/var/lib/postgresql/data",
    );
    expect(service(template, "redis").volumes).toContain("redis_data:/data");
    expect(service(template, "api").environment).toMatchObject({
      APOLLO_TF_AUTH_REDIS_URL: "redis://redis:6379/1",
      DATABASE_URL_FILE: "/run/secrets/tf_database_url",
      REDIS_URL: "redis://redis:6379/0",
    });
    expect(service(template, "api").environment).not.toHaveProperty(
      "DATABASE_URL",
    );
    expect(service(template, "api").ports).toEqual([
      "127.0.0.1:${TF_API_PORT:-8080}:8080",
    ]);
    expect(service(template, "db").ports).toBeUndefined();
    expect(service(template, "redis").ports).toBeUndefined();
    expect(JSON.stringify(template)).not.toMatch(/postgres:\/\/[^"]+:[^"]+@/);

    const documentation = await readFile(modulesDocumentation, "utf8");
    expect(documentation).toContain(
      "`tf_database_url` при первом запуске обновлённого Compose обязан содержать\nтекущий пароль существующей роли",
    );
    expect(documentation).toContain(
      "замена `tf_postgres_password` сама по себе пароль роли\nне меняет",
    );
    expect(documentation).toContain("выполнить `ALTER ROLE ... PASSWORD ...`");
  });

  it("passes a non-default API URL into the Vite build and compiled bundle", async () => {
    const template = await composeTemplate(rootComposePath);
    const web = service(template, "web");
    const dockerfile = await readFile(musicPlayerDockerfile, "utf8");
    const apiOrigin = "https://tf-api.contract.invalid";

    expect(web.build?.args).toEqual({
      VITE_API_URL: "${VITE_API_URL:-https://api.tf.apollot.ru}",
    });
    expect(web.environment ?? {}).not.toHaveProperty("VITE_API_URL");
    expect(dockerfile).toContain("ARG VITE_API_URL");
    expect(dockerfile).toContain("ENV VITE_API_URL=${VITE_API_URL}");

    const outputDirectory = await mkdtemp(
      join(tmpdir(), "apollo-tf-web-bundle-"),
    );
    temporaryDirectories.push(outputDirectory);
    await execFileAsync(
      process.execPath,
      [
        join(musicPlayerDirectory, "node_modules", "vite", "bin", "vite.js"),
        "build",
        "--config",
        "vite.config.ts",
        "--outDir",
        outputDirectory,
      ],
      {
        cwd: musicPlayerDirectory,
        env: {
          ...process.env,
          VITE_API_URL: apiOrigin,
        },
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
    );

    const bundle = (
      await Promise.all(
        (await filesRecursively(outputDirectory)).map((path) =>
          readFile(path, "utf8"),
        ),
      )
    ).join("\n");
    expect(bundle).toContain(apiOrigin);
  }, 60_000);
});
