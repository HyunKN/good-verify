import { test, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fixture } from "./helpers.js";
import { discoverProject } from "../src/adapters/discovery.js";

test("discovery proposes commands without running scripts or writing project files", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.root, "package.json");
    const text = JSON.stringify({
      packageManager: "pnpm@11.19.0",
      scripts: {
        dev: "secret content must not be returned",
        test: "node should-never-run.js",
        "test:e2e": "anything",
        "test;echo": "not a safe name",
        deploy: "never suggest",
      },
      devDependencies: { vite: "8" },
    });
    await fs.writeFile(file, text);
    const before = await fs.readdir(f.root);
    const result = await f.workbench.discover({ root: f.root });
    expect(result.baseUrl).toBe("http://127.0.0.1:5173");
    expect(result.commands.map((c) => c.args)).toEqual([
      ["run", "test"],
      ["run", "test:e2e"],
    ]);
    expect(result.startHint).toBe("pnpm run dev");
    expect(JSON.stringify(result)).not.toContain("secret content");
    expect(await fs.readFile(file, "utf8")).toBe(text);
    expect(await fs.readdir(f.root)).toEqual(before);
  } finally {
    await f.close();
  }
});
test("discovery handles non-Node projects and rejects malformed metadata", async () => {
  const f = await fixture();
  try {
    expect((await discoverProject(f.root)).commands).toEqual([]);
    await expect(discoverProject("relative")).rejects.toThrow("절대 경로");
    await fs.writeFile(path.join(f.root, "package.json"), "not json");
    await expect(discoverProject(f.root)).rejects.toThrow();
    await fs.writeFile(
      path.join(f.root, "package.json"),
      " ".repeat(1024 * 1024 + 1),
    );
    await expect(discoverProject(f.root)).rejects.toThrow("1MiB");
  } finally {
    await f.close();
  }
});
