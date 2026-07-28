import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadAdminDashboardToken } from "./admin-dashboard-token.js";

const VALID_TOKEN = "t".repeat(32);
const temporaryRoots: string[] = [];

async function temporaryPath(name: string, contents?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "apollo-admin-token-"));
  temporaryRoots.push(root);
  const path = join(root, name);
  if (contents === undefined) {
    await mkdir(path);
  } else {
    await writeFile(path, contents);
  }
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("admin dashboard token loader", () => {
  it("returns undefined without a file selector and never reads inline input", () => {
    const readFile = vi.fn();

    expect(
      loadAdminDashboardToken({ ADMIN_DASHBOARD_TOKEN: VALID_TOKEN }, readFile),
    ).toBeUndefined();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("reads only the selected file with the 4-KiB bound", () => {
    const readFile = vi.fn().mockReturnValue(VALID_TOKEN);

    expect(
      loadAdminDashboardToken(
        {
          ADMIN_DASHBOARD_TOKEN_FILE: "/run/secrets/admin_dashboard_token",
          UNRELATED_SECRET_FILE: "/run/secrets/unrelated",
        },
        readFile,
      ),
    ).toBe(VALID_TOKEN);
    expect(readFile).toHaveBeenCalledOnce();
    expect(readFile).toHaveBeenCalledWith(
      "/run/secrets/admin_dashboard_token",
      4_096,
    );
  });

  it.each([
    ["LF", `${VALID_TOKEN}\n`],
    ["CRLF", `${VALID_TOKEN}\r\n`],
  ])("trims one trailing %s newline", (_label, contents) => {
    expect(
      loadAdminDashboardToken(
        { ADMIN_DASHBOARD_TOKEN_FILE: "/run/secrets/token" },
        () => contents,
      ),
    ).toBe(VALID_TOKEN);
  });

  it("does not trim more than one trailing newline", () => {
    expect(() =>
      loadAdminDashboardToken(
        { ADMIN_DASHBOARD_TOKEN_FILE: "/private/token-path" },
        () => `${VALID_TOKEN}\n\n`,
      ),
    ).toThrow("Admin dashboard configuration is invalid");
  });

  it.each([
    ["empty", ""],
    ["short", "s".repeat(31)],
    ["oversized", "o".repeat(4_097)],
  ])("rejects %s file content generically", (_label, contents) => {
    expect(() =>
      loadAdminDashboardToken(
        { ADMIN_DASHBOARD_TOKEN_FILE: "/private/token-path" },
        () => contents,
      ),
    ).toThrow("Admin dashboard configuration is invalid");
  });

  it("rejects a non-regular path", async () => {
    const path = await temporaryPath("token-directory");

    expect(() =>
      loadAdminDashboardToken({ ADMIN_DASHBOARD_TOKEN_FILE: path }),
    ).toThrow("Admin dashboard configuration is invalid");
  });

  it("rejects an unreadable file generically", async () => {
    const path = await temporaryPath("token", VALID_TOKEN);
    await chmod(path, 0o000);

    expect(() =>
      loadAdminDashboardToken({ ADMIN_DASHBOARD_TOKEN_FILE: path }, () => {
        throw new Error(`permission denied: ${path}`);
      }),
    ).toThrow("Admin dashboard configuration is invalid");
  });

  it("rejects dual file and environment configuration", () => {
    expect(() =>
      loadAdminDashboardToken({
        ADMIN_DASHBOARD_TOKEN_FILE: "/private/token-path",
        ADMIN_DASHBOARD_TOKEN: VALID_TOKEN,
      }),
    ).toThrow("Admin dashboard configuration is invalid");
  });

  it.each([
    {
      label: "path",
      path: "/private/admin-dashboard-token",
      secret: VALID_TOKEN,
      readFile: () => {
        throw new Error("unreadable");
      },
    },
    {
      label: "secret",
      path: "/private/token-path",
      secret: "private-secret",
      readFile: (secret: string) => secret,
    },
  ])(
    "does not expose the $label in a failure",
    ({ path, secret, readFile }) => {
      let thrown: unknown;
      try {
        loadAdminDashboardToken({ ADMIN_DASHBOARD_TOKEN_FILE: path }, () =>
          readFile(secret),
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).toBe("Admin dashboard configuration is invalid");
      expect(message).not.toContain(path);
      expect(message).not.toContain(secret);
    },
  );
});
