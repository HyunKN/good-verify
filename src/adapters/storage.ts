import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { idSchema, type ProjectData, type EventRecord } from "../core/model.js";

export function defaultDataDir() {
  return path.join(
    process.env.LOCALAPPDATA ||
      process.env.XDG_DATA_HOME ||
      path.join(
        os.homedir(),
        process.platform === "darwin"
          ? "Library/Application Support"
          : ".local/share",
      ),
    "good-verify",
  );
}
export function within(root: string, child: string) {
  const base = path.resolve(root),
    target = path.resolve(base, child);
  const rel = path.relative(base, target);
  if (rel.startsWith(".." + path.sep) || rel === ".." || path.isAbsolute(rel))
    throw new Error("허용된 디렉터리 밖의 경로입니다.");
  return target;
}
export class Store {
  private queues = new Map<string, Promise<unknown>>();
  constructor(readonly root: string) {}
  projectDir(id: string) {
    return path.join(this.root, "projects", idSchema.parse(id));
  }
  async init() {
    await fs.mkdir(path.join(this.root, "projects"), {
      recursive: true,
      mode: 0o700,
    });
  }
  async atomic(file: string, value: unknown) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = file + "." + randomUUID() + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(tmp, file);
        break;
      } catch (error) {
        // Windows may temporarily deny replacement while a reader/indexer holds
        // the destination. Never delete it first: the previous record stays valid.
        if (
          attempt >= 6 ||
          !["EPERM", "EBUSY", "EACCES"].includes(
            (error as NodeJS.ErrnoException).code || "",
          )
        )
          throw error;
        await delay(20 * (attempt + 1));
      }
    }
  }
  async list(): Promise<ProjectData[]> {
    await this.init();
    const names = await fs.readdir(path.join(this.root, "projects"));
    return Promise.all(
      names
        .filter((n) => idSchema.safeParse(n).success)
        .map((n) => this.read(n)),
    );
  }
  async read(id: string): Promise<ProjectData> {
    return this.exclusive(id, () => this.load(id));
  }
  private async load(id: string): Promise<ProjectData> {
    const data = JSON.parse(
      await fs.readFile(path.join(this.projectDir(id), "project.json"), "utf8"),
    );
    if (data.schemaVersion !== 1 || data.project?.id !== id)
      throw new Error(
        "지원되지 않는 저장 형식 또는 프로젝트 ID입니다. 원본 데이터는 변경하지 않습니다.",
      );
    return data;
  }
  async create(data: ProjectData) {
    await this.atomic(
      path.join(this.projectDir(data.project.id), "project.json"),
      data,
    );
  }
  async exclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.queues.set(id, current);
    try {
      return await current;
    } finally {
      if (this.queues.get(id) === current) this.queues.delete(id);
    }
  }
  async update<T>(
    id: string,
    mutate: (data: ProjectData) => T | Promise<T>,
  ): Promise<T> {
    return this.exclusive(id, async () => {
      const data = await this.load(id);
      const result = await mutate(data);
      await this.atomic(path.join(this.projectDir(id), "project.json"), data);
      return result;
    });
  }
  async append(
    id: string,
    sessionId: string,
    input: Omit<EventRecord, "id" | "seq" | "at" | "sessionId">,
  ) {
    return this.exclusive(id, async () => {
      const data = await this.load(id);
      const s = data.sessions.find((s) => s.id === sessionId);
      if (!s || s.status !== "recording") return;
      const event: EventRecord = {
        ...input,
        id: randomUUID(),
        sessionId,
        seq: ++s.eventCount,
        at: new Date().toISOString(),
      };
      const folder = path.join(
        this.projectDir(id),
        "sessions",
        idSchema.parse(sessionId),
      );
      await fs.mkdir(folder, { recursive: true });
      await fs.appendFile(
        path.join(folder, "events.jsonl"),
        JSON.stringify(event) + "\n",
        { mode: 0o600 },
      );
      await this.atomic(path.join(this.projectDir(id), "project.json"), data);
      return event;
    });
  }
  async events(id: string, sessionId: string): Promise<EventRecord[]> {
    const file = path.join(
      this.projectDir(id),
      "sessions",
      idSchema.parse(sessionId),
      "events.jsonl",
    );
    let text: string;
    try {
      text = await fs.readFile(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const lines = text.split("\n");
    const events: EventRecord[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]) continue;
      try {
        events.push(JSON.parse(lines[i]));
      } catch {
        if (i !== lines.length - 1)
          throw new Error("이벤트 기록이 손상되었습니다.");
      }
    }
    return events;
  }
  async recover() {
    for (const data of await this.list())
      await this.update(data.project.id, async (d) => {
        for (const s of d.sessions)
          if (s.status === "recording") {
            s.status = "incomplete";
            s.endedAt = new Date().toISOString();
            s.notes.push("프로세스 종료로 기록이 중단되었습니다.");
            s.eventCount = (await this.events(data.project.id, s.id)).length;
          }
        for (const r of d.runs)
          if (["queued", "running"].includes(r.status)) {
            r.status = "blocked";
            r.detail = "프로세스 종료로 실행이 중단되었습니다.";
            r.endedAt = new Date().toISOString();
          }
      });
  }
}
