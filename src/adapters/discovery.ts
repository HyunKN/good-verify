import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Project } from "../core/model.js";

export type ProjectSuggestions = {
  name: string;
  baseUrl?: string;
  commands: Project["commands"];
  startHint?: string;
  notes: string[];
};

// Read data only: never import configuration, evaluate scripts, or run a package manager.
export async function discoverProject(
  root: string,
): Promise<ProjectSuggestions> {
  if (!path.isAbsolute(root))
    throw new Error("프로젝트의 절대 경로를 입력하세요.");
  if (!(await fs.stat(root)).isDirectory())
    throw new Error("폴더를 선택하세요.");
  const result: ProjectSuggestions = {
    name: path.basename(root),
    commands: [],
    notes: [
      "제안은 아직 저장되지 않았습니다. 명령은 신뢰하는 프로젝트에서만 등록하세요.",
    ],
  };
  const file = path.join(root, "package.json");
  try {
    const metadata = await fs.lstat(file);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > 1024 * 1024
    )
      throw new Error("package.json은 1MiB 이하의 일반 파일이어야 합니다.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    result.notes.push(
      "package.json이 없습니다. URL과 기존 검사 명령을 직접 입력하세요.",
    );
    return result;
  }
  const pkg = z
    .object({
      scripts: z.record(z.string(), z.string()).default({}),
      dependencies: z.record(z.string(), z.unknown()).default({}),
      devDependencies: z.record(z.string(), z.unknown()).default({}),
      packageManager: z.string().optional(),
    })
    .parse(JSON.parse(await fs.readFile(file, "utf8")));
  const entries = await fs.readdir(root);
  const declared = pkg.packageManager?.split("@")[0];
  const manager = ["pnpm", "npm", "yarn", "bun"].includes(declared || "")
    ? declared!
    : entries.includes("pnpm-lock.yaml")
      ? "pnpm"
      : entries.includes("yarn.lock")
        ? "yarn"
        : entries.includes("bun.lock") || entries.includes("bun.lockb")
          ? "bun"
          : "npm";
  const names = Object.keys(pkg.scripts).filter((name) =>
    /^(test|lint|typecheck|check|build)(:[a-zA-Z0-9_-]+)?$/.test(name),
  );
  result.commands = names.map((name, index) => ({
    id: `detected_${index}`,
    label: name,
    program: manager,
    args: ["run", name],
    timeoutMs: 120000,
  }));
  const start = ["dev", "start"].find((name) => name in pkg.scripts);
  if (start) result.startHint = `${manager} run ${start}`;
  const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
  if ("next" in dependencies) result.baseUrl = "http://127.0.0.1:3000";
  else if ("vite" in dependencies) result.baseUrl = "http://127.0.0.1:5173";
  result.notes.push(
    "개발 서버는 별도 터미널에서 실행하세요. URL은 프레임워크 기본값 추정이며 실제 포트를 확인해야 합니다.",
  );
  result.notes.push(
    "검사 스크립트는 파일을 변경하거나 외부 서비스에 접근할 수 있습니다. 이름만으로 안전성을 보장하지 않습니다.",
  );
  return result;
}
