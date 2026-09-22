import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Locator,
} from "playwright";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  type Project,
  type Action,
  type Assertion,
  type LocatorSpec,
  actionSchema,
  validateScenario,
} from "../core/model.js";
import { recorderScript } from "./recorder-script.js";
import { redact, safeUrl, actionUrl } from "../core/redaction.js";

export function locate(page: Page, spec: LocatorSpec): Locator {
  switch (spec.kind) {
    case "testId":
      return page.getByTestId(spec.value);
    case "label":
      return page.getByLabel(spec.value, { exact: true });
    case "role":
      return page.getByRole(spec.value as Parameters<Page["getByRole"]>[0], {
        name: spec.name,
        exact: true,
      });
    case "text":
      return page.getByText(spec.value, { exact: true });
    case "css":
      return page.locator(spec.value);
  }
}
export async function unique(page: Page, spec?: LocatorSpec) {
  if (!spec) throw new Error("조작 대상이 지정되지 않았습니다.");
  const l = locate(page, spec);
  await l.first().waitFor({ state: "attached", timeout: 5000 });
  const count = await l.count();
  if (count !== 1) throw new Error(`조작 대상이 모호합니다 (${count}개).`);
  return l;
}
export async function perform(page: Page, action: Action, project: Project) {
  if (action.type === "manual")
    throw new Error("수동 확인 필요: " + action.detail);
  if (action.type === "navigate") {
    if (!action.url) throw new Error("URL 누락");
    const url = new URL(action.url, project.baseUrl);
    if (!["http:", "https:"].includes(url.protocol))
      throw new Error("URL protocol not supported");
    await page.goto(url.href);
    return;
  }
  if (action.type === "reload") {
    await page.reload();
    return;
  }
  if (action.type === "press" && !action.locator) {
    await page.keyboard.press(action.value || "Enter");
    return;
  }
  const l = await unique(page, action.locator);
  if (action.type === "click")
    await l.click({ clickCount: action.detail === "double" ? 2 : 1 });
  else if (action.type === "fill") await l.fill(action.value ?? "");
  else if (action.type === "check") await l.setChecked(!!action.checked);
  else if (action.type === "select") await l.selectOption(action.value ?? "");
  else if (action.type === "press") await l.press(action.value || "Enter");
  else if (action.type === "upload") {
    const file = action.fileId && project.files[action.fileId];
    if (!file) throw new Error("등록된 테스트 파일이 필요합니다.");
    await l.setInputFiles(path.resolve(project.root, file));
  }
}
export async function assertPage(page: Page, a: Assertion) {
  const { expect } = await import("@playwright/test");
  if (a.kind === "manual") return;
  if (a.kind === "url") {
    await expect(page).toHaveURL(a.expected, { timeout: 5000 });
    return;
  }
  if (!a.locator) throw new Error("검증 대상이 필요합니다.");
  const l = locate(page, a.locator);
  if (a.kind === "count") {
    const count = Number(a.expected);
    if (!Number.isInteger(count) || count < 0)
      throw new Error("개수는 0 이상의 정수여야 합니다.");
    await expect(l).toHaveCount(count);
    return;
  }
  if ((await l.count()) > 1) throw new Error("검증 대상이 모호합니다.");
  if (a.kind === "visible") await expect(l).toBeVisible();
  else if (a.kind === "hidden") await expect(l).toBeHidden();
  else if (a.kind === "text") await expect(l).toHaveText(a.expected);
  else if (a.kind === "value") await expect(l).toHaveValue(a.expected);
}
export type Recording = {
  browser: Browser;
  context: BrowserContext;
  pages: Map<string, Page>;
  stop: () => Promise<void>;
  screenshot: () => Promise<Buffer>;
};
export async function recordBrowser(
  project: Project,
  callbacks: {
    event: (
      kind: string,
      data: Record<string, unknown>,
      pageId?: string,
    ) => Promise<void>;
    marker: (data: Record<string, unknown>, pageId: string) => Promise<void>;
    closed: () => Promise<void>;
  },
  headless = false,
  storageState?: string,
): Promise<Recording> {
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    storageState,
  });
  const pages = new Map<string, Page>();
  const ids = new Map<Page, string>();
  let stopped = false;
  let lastAction = 0;
  let count = 0;
  const pending = new Set<Promise<void>>();
  let deliveryFailed = false;
  let deliveryError = "";
  const track = (p: Promise<void>) => {
    pending.add(p);
    void p
      .catch((error) => {
        deliveryFailed = true;
        deliveryError = redact(
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(() => pending.delete(p));
    return p;
  };
  const emit = (
    kind: string,
    data: Record<string, unknown>,
    pageId?: string,
  ) => {
    const p = callbacks.event(kind, data, pageId);
    track(p);
  };
  await context.exposeBinding("__gvRecord", async ({ page }, raw: unknown) => {
    const parsed = z
      .object({
        kind: z.enum(["action", "marker"]),
        data: z.record(z.string(), z.unknown()),
      })
      .parse(raw);
    const pageId = ids.get(page) || "page-1";
    if (parsed.kind === "action") {
      lastAction = Date.now();
      const action = actionSchema.parse({ ...parsed.data, pageId });
      await track(callbacks.event("action", action, pageId));
    } else await track(callbacks.marker(parsed.data, pageId));
  });
  // tsx's keepNames transform references this helper. Scope it to the injected
  // closure so recording works both from the source CLI and test transpilers.
  await context.addInitScript({
    content: `(() => { const __name = (value) => value; (${recorderScript.toString()})(); })();`,
  });
  const attach = (page: Page) => {
    const pageId = "page-" + ++count;
    ids.set(page, pageId);
    pages.set(pageId, page);
    if (count > 1)
      emit("action", { type: "page-open", pageId, detail: "popup" }, pageId);
    page.on("console", (m) =>
      emit(
        "console",
        { level: m.type(), text: redact(m.text()).slice(0, 8000) },
        pageId,
      ),
    );
    page.on("pageerror", (e) =>
      emit("error", { text: redact(e.message).slice(0, 8000) }, pageId),
    );
    page.on("response", (r) =>
      emit(
        "network",
        {
          method: r.request().method(),
          url: safeUrl(r.url()),
          status: r.status(),
        },
        pageId,
      ),
    );
    page.on("requestfailed", (r) =>
      emit(
        "network",
        {
          method: r.method(),
          url: safeUrl(r.url()),
          error: redact(r.failure()?.errorText || ""),
        },
        pageId,
      ),
    );
    page.on("download", (d) =>
      emit(
        "download",
        { name: d.suggestedFilename(), url: safeUrl(d.url()) },
        pageId,
      ),
    );
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame() && frame.url() !== "about:blank")
        emit(
          "action",
          {
            type: "navigate",
            url: actionUrl(frame.url()),
            pageId,
            detail: Date.now() - lastAction < 2500 ? "observed" : "direct",
          },
          pageId,
        );
    });
    page.on("close", () => {
      emit("action", { type: "page-close", pageId }, pageId);
    });
  };
  context.on("page", attach);
  browser.on("disconnected", () => {
    if (!stopped) void callbacks.closed().catch(() => {});
  });
  try {
    const page = await context.newPage();
    await page.goto(project.baseUrl, { timeout: 30000 });
  } catch (e) {
    stopped = true;
    await browser.close();
    throw e;
  }
  return {
    browser,
    context,
    pages,
    stop: async () => {
      stopped = true;
      for (const page of pages.values())
        if (!page.isClosed())
          await page
            .evaluate(async () => {
              await (
                window as unknown as { __gvFlush?: () => Promise<void> }
              ).__gvFlush?.();
            })
            .catch(() => {});
      await Promise.allSettled([...pending]);
      await browser.close();
      await Promise.allSettled([...pending]);
      if (deliveryFailed)
        throw new Error(
          "일부 이벤트 저장에 실패했습니다. 불완전한 기록입니다. " +
            deliveryError,
        );
    },
    screenshot: async () => {
      const page = [...pages.values()].find((p) => !p.isClosed());
      if (!page) throw new Error("열린 페이지가 없습니다.");
      return page.screenshot({
        mask: [
          page.locator(
            "input[type=password],input[autocomplete*=cc-],[data-gv-recorder]",
          ),
        ],
        fullPage: false,
      });
    },
  };
}
export async function replayScenario(
  project: Project,
  steps: Action[],
  assertions: Assertion[],
  options: {
    headless: boolean;
    signal: AbortSignal;
    artifactDir: string;
    storageState?: string;
    onStep: (index: number, status: string, detail: string) => Promise<void>;
  },
) {
  validateScenario(steps, assertions);
  const browser = await chromium.launch({ headless: options.headless });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    storageState: options.storageState,
  });
  const pages = new Map<string, Page>();
  const onAbort = () => {
    void browser.close();
  };
  options.signal.addEventListener("abort", onAbort, { once: true });
  let manual = false;
  let active: Page | undefined;
  try {
    const page = await context.newPage();
    active = page;
    pages.set("page-1", page);
    await page.goto(project.baseUrl, { timeout: 15000 });
    const check = async (index: number) => {
      for (const a of assertions.filter(
        (a) => (a.afterStep ?? steps.length) === index,
      )) {
        if (a.kind === "manual") {
          manual = true;
          continue;
        }
        const p = pages.get(a.pageId);
        if (!p) throw new Error("검증할 페이지가 없습니다.");
        await assertPage(p, a);
      }
    };
    await check(0);
    for (let i = 0; i < steps.length; i++) {
      if (options.signal.aborted) throw new Error("실행 취소");
      const step = steps[i];
      if (step.type === "manual") {
        manual = true;
        await options.onStep(
          i,
          "manual-required",
          step.detail || "수동 확인 필요",
        );
        break;
      }
      let p = pages.get(step.pageId);
      if (step.type === "page-open") {
        p = context.pages().find((p) => ![...pages.values()].includes(p));
        if (!p) throw new Error("기록된 팝업이 열리지 않았습니다.");
        pages.set(step.pageId, p);
      } else if (step.type === "page-close") {
        await p?.close();
      } else {
        if (!p) throw new Error("조작할 페이지가 없습니다.");
        active = p;
        await perform(p, step, project);
      }
      await options.onStep(i, "passed", step.type);
      await check(i + 1);
    }
    if (!assertions.length) manual = true;
    return { manual };
  } finally {
    await fs.mkdir(options.artifactDir, { recursive: true });
    if (active && !active.isClosed())
      await active
        .screenshot({
          path: path.join(options.artifactDir, "result.png"),
          mask: [
            active.locator("input[type=password],input[autocomplete*=cc-]"),
          ],
        })
        .catch(() => {});
    options.signal.removeEventListener("abort", onAbort);
    await browser.close();
  }
}
