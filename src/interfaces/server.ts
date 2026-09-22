import Fastify from "fastify";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";
import { z, ZodError } from "zod";
import { Store, within } from "../adapters/storage.js";
import { Workbench } from "../application/workbench.js";
import { idSchema } from "../core/model.js";
import { redact } from "../core/redaction.js";
import {
  htmlReport,
  markdownReport,
  issueTemplate,
} from "../adapters/report.js";
const dist = fileURLToPath(new URL("../../dist/ui/", import.meta.url));
const same = (a: string, b: string) =>
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
export async function createServer(options: {
  dataDir: string;
  headless?: boolean;
  port?: number;
  dev?: boolean;
  token?: string;
}) {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  const token = options.token || randomBytes(32).toString("hex");
  // The cookie must not be the API token itself: cookies cannot be scoped to a
  // port, so any other loopback service under /api/v1 would receive it. Session
  // ids are revocable and meaningless outside this process.
  const sessions = new Set<string>();
  const nonces = new Map<string, number>();
  const issueNonce = () => {
    const at = Date.now();
    for (const [value, expiry] of nonces)
      if (expiry <= at) nonces.delete(value);
    while (nonces.size >= 64) nonces.delete(nonces.keys().next().value!);
    const nonce = randomBytes(32).toString("hex");
    nonces.set(nonce, at + 300000);
    return nonce;
  };
  const consumeNonce = (value: unknown) => {
    if (typeof value !== "string") return false;
    const expiry = nonces.get(value);
    nonces.delete(value);
    return expiry !== undefined && expiry > Date.now();
  };
  const workbench = new Workbench(new Store(options.dataDir), options.headless);
  await workbench.init();
  const port = options.port ?? 4318;
  const origins = new Set([
    `http://127.0.0.1:${port}`,
    ...(options.dev ? ["http://127.0.0.1:5173"] : []),
  ]);
  const streams = new Set<ServerResponse>();
  app.addHook("preClose", async () => {
    for (const stream of streams) stream.end();
  });
  app.addHook("onRequest", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    const host = req.headers.host || "";
    if (
      host !== `127.0.0.1:${port}` &&
      !(options.dev && host === "127.0.0.1:5173")
    )
      return reply.code(403).send({ error: "허용되지 않은 Host" });
    const origin = req.headers.origin;
    if (origin && !origins.has(origin))
      return reply.code(403).send({ error: "허용되지 않은 Origin" });
    if (req.headers["sec-fetch-site"] === "cross-site")
      return reply
        .code(403)
        .send({ error: "교차 사이트 요청은 허용하지 않습니다." });
    if (!req.url.startsWith("/api/")) return;
    if (req.url === "/api/v1/ui-session" && req.method === "POST") return;
    const bearer = req.headers.authorization?.replace(/^Bearer /, "");
    const cookie = req.headers.cookie
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("gv-session="))
      ?.slice(11);
    const bearerValid = !!bearer && same(bearer, token);
    if (!bearerValid && !(cookie && sessions.has(cookie)))
      return reply.code(401).send({ error: "로컬 인증이 필요합니다." });
    if (!bearerValid && !["GET", "HEAD"].includes(req.method) && !origin)
      return reply.code(403).send({ error: "Origin이 필요합니다." });
  });
  app.setErrorHandler((error, _req, reply) => {
    reply.code(400).send({
      error:
        error instanceof ZodError
          ? "입력 형식을 확인하세요: " +
            error.issues
              .map((i) => i.path.join(".") + " " + i.message)
              .join("; ")
          : redact(
              error instanceof Error
                ? error.message
                : "요청을 처리할 수 없습니다.",
            ),
    });
  });
  app.post("/api/v1/ui-session", async (req, reply) => {
    if (
      !req.headers.origin ||
      !origins.has(req.headers.origin) ||
      req.headers["x-gv-ui"] !== "1"
    )
      return reply.code(403).send({ error: "로컬 화면에서 시작하세요." });
    // The nonce proves the caller actually loaded index.html from this service,
    // which a raw HTTP client cannot do by setting headers alone. Under --dev the
    // UI comes from Vite and cannot carry one, so that documented dev-only
    // widening keeps the previous behaviour.
    if (!options.dev && !consumeNonce((req.body as { nonce?: unknown })?.nonce))
      return reply
        .code(403)
        .send({ error: "화면을 새로고침한 뒤 다시 시작하세요." });
    const session = randomBytes(32).toString("hex");
    while (sessions.size >= 32)
      sessions.delete(sessions.values().next().value!);
    sessions.add(session);
    reply.header(
      "Set-Cookie",
      `gv-session=${session}; HttpOnly; SameSite=Strict; Path=/api/v1`,
    );
    return { ready: true };
  });
  const pid = (req: { params: unknown }) =>
    idSchema.parse((req.params as { pid: string }).pid);
  const sub = (req: { params: unknown }, key: string) =>
    idSchema.parse((req.params as Record<string, string>)[key]);
  app.get("/api/v1/projects", async () => ({
    projects: (await workbench.store.list()).map((d) => d.project),
  }));
  app.post("/api/v1/projects", async (req) => workbench.connect(req.body));
  app.post("/api/v1/project-suggestions", async (req) =>
    workbench.discover(req.body),
  );
  app.put("/api/v1/projects/:pid", async (req) =>
    workbench.configure(pid(req), req.body),
  );
  app.get("/api/v1/projects/:pid", async (req) => workbench.snapshot(pid(req)));
  app.get("/api/v1/projects/:pid/config", async (req) =>
    workbench.exportProject(pid(req)),
  );
  app.post("/api/v1/projects/:pid/work-items", async (req) =>
    workbench.work(pid(req), req.body),
  );
  app.put("/api/v1/projects/:pid/work-items/:wid", async (req) =>
    workbench.work(pid(req), req.body, sub(req, "wid")),
  );
  app.post("/api/v1/projects/:pid/work-items/:wid/reviews", async (req) =>
    workbench.review(pid(req), sub(req, "wid"), req.body),
  );
  app.post("/api/v1/projects/:pid/sessions", async (req) => {
    const b = z
      .object({ workItemId: idSchema.optional() })
      .parse(req.body || {});
    return workbench.startSession(pid(req), b.workItemId);
  });
  app.post("/api/v1/projects/:pid/sessions/:sid/stop", async (req) => {
    await workbench.stopSession(pid(req), sub(req, "sid"));
    return { ok: true };
  });
  app.post("/api/v1/projects/:pid/sessions/:sid/browser-state", async (req) =>
    workbench.saveBrowserState(pid(req), sub(req, "sid")),
  );
  app.get("/api/v1/projects/:pid/sessions/:sid/events", async (req) => ({
    events: await workbench.store.events(pid(req), sub(req, "sid")),
  }));
  app.post("/api/v1/projects/:pid/findings", async (req) =>
    workbench.finding(pid(req), req.body),
  );
  app.patch("/api/v1/projects/:pid/findings/:fid", async (req) =>
    workbench.updateFinding(pid(req), sub(req, "fid"), req.body),
  );
  app.post("/api/v1/projects/:pid/scenarios", async (req) =>
    workbench.draft(pid(req), req.body),
  );
  app.put("/api/v1/projects/:pid/scenarios/:sid", async (req) =>
    workbench.updateScenario(pid(req), sub(req, "sid"), req.body),
  );
  app.post("/api/v1/projects/:pid/scenarios/:sid/register", async (req) =>
    workbench.register(pid(req), sub(req, "sid"), req.body),
  );
  app.get("/api/v1/projects/:pid/scenarios/:sid/source", async (req, reply) =>
    reply
      .type("text/plain; charset=utf-8")
      .send(await workbench.testSource(pid(req), sub(req, "sid"))),
  );
  app.post("/api/v1/projects/:pid/runs", async (req, reply) =>
    reply.code(202).send(await workbench.startRun(pid(req), req.body)),
  );
  app.post("/api/v1/projects/:pid/runs/:rid/cancel", async (req) => {
    await workbench.cancel(pid(req), sub(req, "rid"));
    return { ok: true };
  });
  app.post("/api/v1/projects/:pid/runs/:rid/manual", async (req) =>
    workbench.manual(pid(req), sub(req, "rid"), req.body),
  );
  app.get("/api/v1/projects/:pid/report", async (req, reply) => {
    const q = z
      .object({
        workItemId: idSchema.optional(),
        format: z.enum(["json", "html", "markdown", "issue"]).default("json"),
      })
      .parse(req.query);
    const r = await workbench.report(pid(req), q.workItemId);
    if (q.format === "json") return r;
    reply.header(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:",
    );
    return reply
      .type(
        q.format === "html"
          ? "text/html; charset=utf-8"
          : "text/plain; charset=utf-8",
      )
      .send(
        q.format === "html"
          ? htmlReport({ ...r, evidence: [] })
          : q.format === "issue"
            ? issueTemplate(r)
            : markdownReport(r),
      );
  });
  app.post("/api/v1/projects/:pid/report/export", async (req) =>
    workbench.exportReport(pid(req), req.body),
  );
  app.get("/api/v1/projects/:pid/evidence/:eid", async (req, reply) => {
    const data = await workbench.store.read(pid(req));
    const e = data.evidence.find((e) => e.id === sub(req, "eid"));
    if (!e) return reply.code(404).send({ error: "근거를 찾을 수 없습니다." });
    return reply
      .header("X-Content-Type-Options", "nosniff")
      .type(e.mime)
      .send(
        await fs.readFile(
          within(workbench.store.projectDir(pid(req)), e.relativePath),
        ),
      );
  });
  app.get("/api/v1/projects/:pid/events", async (req, reply) => {
    const id = pid(req);
    await workbench.store.read(id);
    reply.hijack();
    streams.add(reply.raw);
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    reply.raw.write("event: ready\ndata: {}\n\n");
    const change = (projectId: string) => {
      if (projectId === id) reply.raw.write("event: change\ndata: {}\n\n");
    };
    workbench.on("change", change);
    const timer = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15000);
    req.raw.on("close", () => {
      streams.delete(reply.raw);
      clearInterval(timer);
      workbench.off("change", change);
    });
  });
  app.get("/health", async () => ({
    product: "good-verify",
    status: "ok",
    version: "0.1.0-alpha.1",
  }));
  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith("/api/"))
      return reply.code(404).send({ error: "경로를 찾을 수 없습니다." });
    let url: string;
    try {
      url = decodeURIComponent(req.url.split("?")[0]);
    } catch {
      return reply.code(400).send();
    }
    const file = within(dist, url === "/" ? "index.html" : url.slice(1));
    try {
      const body = await fs.readFile(file);
      const ext = path.extname(file);
      if (ext === ".html")
        return reply
          .type("text/html; charset=utf-8")
          .send(
            body
              .toString()
              .replace(
                "</head>",
                `<meta name="gv-nonce" content="${issueNonce()}"/></head>`,
              ),
          );
      return reply
        .type(
          (
            {
              ".html": "text/html; charset=utf-8",
              ".js": "text/javascript",
              ".css": "text/css",
              ".svg": "image/svg+xml",
            } as Record<string, string>
          )[ext] || "application/octet-stream",
        )
        .send(body);
    } catch {
      return reply
        .type("text/html")
        .send("<p>UI 빌드가 필요합니다. pnpm build 후 다시 시작하세요.</p>");
    }
  });
  app.addHook("onClose", async () => workbench.close());
  return { app, workbench, token };
}
