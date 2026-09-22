import { it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fixture } from "./helpers.js";
import { Store, within } from "../src/adapters/storage.js";
import { createServer } from "../src/interfaces/server.js";
it("isolates projects and rejects traversal", async () => {
  const f = await fixture();
  try {
    const p2 = await f.workbench.connect({
      name: "Second",
      root: f.root,
      baseUrl: "http://localhost/",
    });
    await f.workbench.work(f.project.id, { title: "Only first" });
    expect((await f.workbench.snapshot(p2.id)).workItems).toHaveLength(0);
    expect(() => within(f.dir, "../escape")).toThrow();
    await expect(f.workbench.store.read("../escape")).rejects.toThrow();
  } finally {
    await f.close();
  }
});
it("commands retain failures and code changes invalidate successful evidence", async () => {
  const f = await fixture();
  try {
    const w = await f.workbench.work(f.project.id, {
      title: "Validate",
      requirement: "Check succeeds",
      criteria: ["Exit zero"],
      requiredCommandIds: ["check"],
    });
    await f.workbench.startRun(f.project.id, {
      kind: "command",
      targetId: "fail",
      workItemId: w.id,
    });
    await f.workbench.idle();
    await f.workbench.startRun(f.project.id, {
      kind: "command",
      targetId: "check",
      workItemId: w.id,
    });
    await f.workbench.idle();
    await f.workbench.review(f.project.id, w.id, {
      reviewer: "Owner",
      verdict: "approved",
      evidence: "Reviewed source",
    });
    let d = await f.workbench.snapshot(f.project.id);
    expect(d.runs.map((r) => r.status)).toEqual(["failed", "passed"]);
    expect(d.gates[w.id].complete).toBe(true);
    await fs.writeFile(path.join(f.root, "source.txt"), "changed");
    d = await f.workbench.snapshot(f.project.id);
    expect(d.gates[w.id].complete).toBe(false);
  } finally {
    await f.close();
  }
});
it("cancels only its registered job and handles timeout", async () => {
  const f = await fixture();
  try {
    const run = await f.workbench.startRun(f.project.id, {
      kind: "command",
      targetId: "slow",
    });
    await f.workbench.cancel(f.project.id, run.id);
    await f.workbench.idle();
    expect((await f.workbench.snapshot(f.project.id)).runs[0].status).toBe(
      "cancelled",
    );
    await f.workbench.startRun(f.project.id, {
      kind: "command",
      targetId: "slow",
    });
    await f.workbench.idle();
    expect((await f.workbench.snapshot(f.project.id)).runs[1].status).toBe(
      "blocked",
    );
  } finally {
    await f.close();
  }
});
it("recovers unfinished runs without claiming completion", async () => {
  const f = await fixture();
  try {
    await f.workbench.store.update(f.project.id, (d) => {
      d.runs.push({
        id: "unfinished",
        projectId: f.project.id,
        kind: "command",
        targetId: "check",
        status: "running",
        code: {
          revision: "x",
          dirty: true,
          fingerprint: "x",
          capturedAt: "now",
        },
        createdAt: "now",
        detail: "",
        steps: [],
        evidenceIds: [],
        manualChecks: [],
      });
    });
    await new Store(f.workbench.store.root).recover();
    expect((await f.workbench.snapshot(f.project.id)).runs[0].status).toBe(
      "blocked",
    );
  } finally {
    await f.close();
  }
});
it("API requires local token or same-origin UI session", async () => {
  const f = await fixture();
  const { app, token } = await createServer({
    dataDir: path.join(f.dir, "api"),
    headless: true,
  });
  try {
    expect(
      (
        await app.inject({
          url: "/api/v1/projects",
          headers: { host: "127.0.0.1:4318" },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          url: "/api/v1/projects",
          headers: {
            host: "127.0.0.1:4318",
            authorization: `Bearer ${token}`,
            origin: "https://foreign.invalid",
          },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: "/api/v1/projects",
          headers: { host: "127.0.0.1:4318", authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(200);
    // Header-only bootstrap must not hand out authority: a raw local client can
    // set Host, Origin and x-gv-ui, but cannot obtain a served-page nonce.
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/ui-session",
          headers: {
            host: "127.0.0.1:4318",
            origin: "http://127.0.0.1:4318",
            "x-gv-ui": "1",
          },
        })
      ).statusCode,
    ).toBe(403);
    const page = await app.inject({
      url: "/",
      headers: { host: "127.0.0.1:4318" },
    });
    const nonce = /name="gv-nonce" content="([a-f0-9]+)"/.exec(page.body)?.[1];
    expect(
      nonce,
      "The nonce ships in the served index.html, so the UI must be built first. Run pnpm build, or pnpm verify which builds before testing.",
    ).toBeTruthy();
    const bootstrap = await app.inject({
      method: "POST",
      url: "/api/v1/ui-session",
      headers: {
        host: "127.0.0.1:4318",
        origin: "http://127.0.0.1:4318",
        "x-gv-ui": "1",
      },
      payload: { nonce },
    });
    expect(bootstrap.statusCode).toBe(200);
    const session = /gv-session=([a-f0-9]+)/.exec(
      String(bootstrap.headers["set-cookie"]),
    )?.[1];
    // The cookie must be a revocable session id, never the API token itself.
    expect(session).toBeTruthy();
    expect(session).not.toBe(token);
    expect(
      (
        await app.inject({
          url: "/api/v1/projects",
          headers: { host: "127.0.0.1:4318", cookie: `gv-session=${session}` },
        })
      ).statusCode,
    ).toBe(200);
    // A session id is not an API token, and a consumed nonce cannot be replayed.
    expect(
      (
        await app.inject({
          url: "/api/v1/projects",
          headers: {
            host: "127.0.0.1:4318",
            authorization: `Bearer ${session}`,
          },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/ui-session",
          headers: {
            host: "127.0.0.1:4318",
            origin: "http://127.0.0.1:4318",
            "x-gv-ui": "1",
          },
          payload: { nonce },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: "/api/v1/projects",
          headers: { host: "evil.invalid", authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(403);
  } finally {
    await app.close();
    await f.close();
  }
});
