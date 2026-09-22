// This function is serialized into each inspected page. Keep it self-contained.
export function recorderScript() {
  const win = window as unknown as {
    __gvRecord: (event: unknown) => Promise<void>;
    __gvFlush: () => Promise<void>;
  };
  let tail = Promise.resolve();
  const send = (kind: string, data: Record<string, unknown>) => {
    const delivery = win.__gvRecord({ kind, data });
    tail = Promise.all([tail.catch(() => {}), delivery]).then(() => {});
    void tail.catch(() => {});
  };
  const pending = new Map<Element, string>();
  let timer: ReturnType<typeof setTimeout>;
  let lastKeyboard = 0;
  let pointerStart: { x: number; y: number; target: Element } | undefined;
  const excluded = (e: Event) =>
    e
      .composedPath()
      .some((n) => n instanceof Element && n.hasAttribute("data-gv-recorder"));
  const sensitive = (el: Element) =>
    el instanceof HTMLInputElement &&
    (el.type === "password" ||
      /password|secret|token|credit|card|otp/i.test(
        [el.name, el.id, el.autocomplete].join(" "),
      ));
  const selector = (el: Element): Record<string, string> | undefined => {
    const test = el.getAttribute("data-testid");
    if (test) return { kind: "testId", value: test };
    const aria = el.getAttribute("aria-label");
    if (aria) return { kind: "label", value: aria };
    const labelled = el.getAttribute("aria-labelledby");
    if (labelled) {
      const text = labelled
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim() || "")
        .join(" ");
      if (text) return { kind: "label", value: text };
    }
    const labels = (el as HTMLInputElement).labels;
    if (labels?.length && labels[0].textContent?.trim())
      return { kind: "label", value: labels[0].textContent.trim() };
    const role =
      el.getAttribute("role") ||
      (
        {
          BUTTON: "button",
          A: "link",
          TEXTAREA: "textbox",
          SELECT: "combobox",
        } as Record<string, string>
      )[el.tagName];
    if (role && el.textContent?.trim())
      return {
        kind: "role",
        value: role,
        name: el.textContent.trim().replace(/\s+/g, " "),
      };
    if (
      el.id &&
      document.querySelectorAll("#" + CSS.escape(el.id)).length === 1
    )
      return { kind: "css", value: "#" + CSS.escape(el.id) };
    const text = el.textContent?.trim();
    if (text && text.length < 160 && el.children.length === 0)
      return { kind: "text", value: text };
  };
  const action = (
    type: string,
    el?: Element,
    extra: Record<string, unknown> = {},
  ) => {
    if (window.top !== window.self) {
      send("action", {
        type: "manual",
        detail: "프레임 내부 조작: 수동 확인 필요",
      });
      return;
    }
    const locator = el ? selector(el) : undefined;
    if (el && (sensitive(el) || el.closest("canvas") || !locator)) {
      send("action", {
        type: "manual",
        detail: sensitive(el)
          ? "비밀 입력은 기록하지 않습니다."
          : "자동 식별 불가 조작: " + el.tagName,
      });
      return;
    }
    send("action", {
      type,
      ...(locator ? { locator } : {}),
      ...extra,
      timestamp: Date.now(),
    });
  };
  const flush = () => {
    clearTimeout(timer);
    for (const [el, value] of pending) action("fill", el, { value });
    pending.clear();
  };
  win.__gvFlush = async () => {
    flush();
    await tail;
  };
  document.addEventListener(
    "input",
    (e) => {
      if (!e.isTrusted || excluded(e)) return;
      const el = e.target;
      if (!(
        el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
      ))
        return;
      if (["checkbox", "radio", "file"].includes(el.type)) return;
      pending.set(el, sensitive(el) ? "" : el.value);
      clearTimeout(timer);
      timer = setTimeout(flush, 200);
    },
    true,
  );
  document.addEventListener(
    "compositionend",
    (e) => {
      if (excluded(e)) return;
      const el = e.target;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
        pending.set(el, sensitive(el) ? "" : el.value);
      flush();
    },
    true,
  );
  document.addEventListener(
    "change",
    (e) => {
      if (!e.isTrusted || excluded(e)) return;
      flush();
      const el = e.target;
      if (el instanceof HTMLSelectElement)
        action("select", el, { value: el.value });
      else if (el instanceof HTMLInputElement) {
        if (["checkbox", "radio"].includes(el.type))
          action("check", el, { checked: el.checked });
        else if (el.type === "file")
          action("upload", el, {
            detail:
              "테스트 파일을 연결하세요: " +
              [...(el.files || [])].map((f) => f.name).join(", "),
          });
      }
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (e) => {
      if (!e.isTrusted || excluded(e)) return;
      if (
        [
          "Enter",
          "Escape",
          "Tab",
          "ArrowUp",
          "ArrowDown",
          "ArrowLeft",
          "ArrowRight",
        ].includes(e.key) ||
        ((e.ctrlKey || e.metaKey) && e.key.length === 1)
      ) {
        flush();
        lastKeyboard = Date.now();
        const el = e.target instanceof Element ? e.target : undefined;
        const combo = [
          e.ctrlKey ? "Control" : "",
          e.metaKey ? "Meta" : "",
          e.altKey ? "Alt" : "",
          e.shiftKey ? "Shift" : "",
          e.key,
        ]
          .filter(Boolean)
          .join("+");
        action("press", el?.tagName === "BODY" ? undefined : el, {
          value: combo,
        });
      }
    },
    true,
  );
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!e.isTrusted || excluded(e)) return;
      flush();
      if (e.target instanceof Element)
        pointerStart = { x: e.clientX, y: e.clientY, target: e.target };
    },
    true,
  );
  document.addEventListener(
    "pointerup",
    (e) => {
      if (!e.isTrusted || excluded(e)) return;
      if (
        pointerStart &&
        Math.hypot(e.clientX - pointerStart.x, e.clientY - pointerStart.y) > 12
      )
        send("action", {
          type: "manual",
          detail: "드래그: 수동 검증 필요",
          from: { x: pointerStart.x, y: pointerStart.y },
          to: { x: e.clientX, y: e.clientY },
        });
      pointerStart = undefined;
    },
    true,
  );
  document.addEventListener(
    "click",
    (e) => {
      if (!e.isTrusted || excluded(e) || picking) return;
      flush();
      if (e.detail === 0 && Date.now() - lastKeyboard < 500) return;
      const el =
        e.target instanceof Element
          ? e.target.closest(
              'button,a,input,select,textarea,[role="button"],[role="checkbox"],canvas,label',
            ) || e.target
          : undefined;
      if (!el) return;
      if (
        el instanceof HTMLInputElement &&
        [
          "checkbox",
          "radio",
          "text",
          "password",
          "email",
          "number",
          "file",
          "search",
        ].includes(el.type)
      )
        return;
      if (
        el instanceof HTMLSelectElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLLabelElement && el.control)
      )
        return;
      action("click", el, {
        detail: e.detail === 2 ? "double-second" : undefined,
      });
    },
    true,
  );
  window.addEventListener("pagehide", flush);
  window.addEventListener("popstate", () =>
    send("action", {
      type: "manual",
      detail: "브라우저 이력 이동: 준비 절차를 확인하세요.",
    }),
  );
  let picking = false;
  let picked: Element | undefined;
  if (window.top !== window.self) return;
  const mount = () => {
    if (document.querySelector("[data-gv-recorder]")) return;
    const host = document.createElement("div");
    host.setAttribute("data-gv-recorder", "");
    host.style.cssText =
      "position:fixed;right:16px;top:12px;z-index:2147483647";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>:host{font:13px sans-serif;color:#fff}section{background:#2a2a2a;padding:10px;border-radius:10px;box-shadow:0 4px 20px #0004;max-width:300px}button,select,input,textarea{font:inherit;border-radius:5px;border:1px solid #6b6b6b;padding:7px;margin:3px}button{cursor:pointer;background:#fff;color:#343434}small{display:block;color:#cdcdcd}textarea,input{box-sizing:border-box;width:96%;background:#fff;color:#222}#editor{display:none}</style><section><small>● good-verify · 기록 중</small><button id="mark">문제 표시</button><button id="pick">검증 지점 선택</button><div id="editor"><input id="title" placeholder="어떤 상황인가요?"/><select id="kind"><option value="manual">문제 / 수동 확인</option><option value="visible">보여야 함</option><option value="hidden">숨겨져야 함</option><option value="text">텍스트</option><option value="value">입력값</option><option value="count">개수</option></select><textarea id="expected" placeholder="기대 결과를 직접 입력하세요"></textarea><button id="save">기록에 남기기</button><button id="cancel">닫기</button></div></section>`;
    document.documentElement.appendChild(host);
    const q = <T extends HTMLElement>(id: string) =>
      shadow.getElementById(id) as T;
    q("mark").onclick = () => {
      picked = undefined;
      q("editor").style.display = "block";
      q<HTMLSelectElement>("kind").value = "manual";
    };
    q("pick").onclick = () => {
      picking = true;
      q("pick").textContent = "확인할 요소를 클릭하세요";
    };
    document.addEventListener(
      "click",
      (e) => {
        if (!picking || excluded(e)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        picking = false;
        picked = e.target as Element;
        q("pick").textContent = "검증 지점 선택";
        q("editor").style.display = "block";
        q<HTMLSelectElement>("kind").value = "visible";
      },
      true,
    );
    q("cancel").onclick = () => {
      q("editor").style.display = "none";
    };
    q("save").onclick = () => {
      flush();
      const kind = q<HTMLSelectElement>("kind").value,
        expected = q<HTMLTextAreaElement>("expected").value;
      if (kind !== "visible" && kind !== "hidden" && !expected.trim()) {
        q<HTMLTextAreaElement>("expected").focus();
        return;
      }
      send("marker", {
        title: q<HTMLInputElement>("title").value || "검증 지점",
        expected,
        actual: "",
        assertion:
          kind !== "manual" && picked
            ? { kind, expected, locator: selector(picked) }
            : undefined,
      });
      q("editor").style.display = "none";
      q<HTMLInputElement>("title").value = "";
      q<HTMLTextAreaElement>("expected").value = "";
    };
  };
  if (document.documentElement) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
}
