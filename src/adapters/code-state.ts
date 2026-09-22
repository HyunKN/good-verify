import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { CodeState } from "../core/model.js";
const exec = promisify(execFile);
export async function codeState(root: string): Promise<CodeState> {
  const hash = createHash("sha256");
  let revision = "unversioned",
    dirty = true;
  try {
    revision = (
      await exec("git", ["rev-parse", "HEAD"], { cwd: root })
    ).stdout.trim();
    const status = (
      await exec("git", ["status", "--porcelain", "-z"], {
        cwd: root,
        maxBuffer: 16 * 1024 * 1024,
      })
    ).stdout;
    dirty = !!status;
    hash.update(revision).update(status);
    hash.update(
      (
        await exec("git", ["diff", "HEAD", "--binary"], {
          cwd: root,
          maxBuffer: 64 * 1024 * 1024,
        })
      ).stdout,
    );
    const untracked = (
      await exec("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
        cwd: root,
        maxBuffer: 16 * 1024 * 1024,
      })
    ).stdout
      .split("\0")
      .filter(Boolean)
      .sort();
    for (const file of untracked) {
      hash.update(file);
      hash.update(await fs.readFile(path.join(root, file)));
    }
  } catch (e) {
    if (revision !== "unversioned") throw e;
    const walk = async (dir: string) => {
      for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort(
        (a, b) => a.name.localeCompare(b.name),
      )) {
        if (
          [
            "node_modules",
            ".git",
            "dist",
            "build",
            ".next",
            "coverage",
            "test-results",
            ".good-verify",
          ].includes(entry.name) ||
          entry.name.startsWith(".env")
        )
          continue;
        const target = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(target);
        else if (entry.isFile()) {
          hash.update(path.relative(root, target));
          hash.update(await fs.readFile(target));
        }
      }
    };
    await walk(root);
  }
  return {
    revision,
    dirty,
    fingerprint: hash.digest("hex"),
    capturedAt: new Date().toISOString(),
  };
}
