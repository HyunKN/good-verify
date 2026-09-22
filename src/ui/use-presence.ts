import { useLayoutEffect, useRef, useState } from "react";

// Keep the outgoing tree mounted until its exit finishes. A newer request
// cancels the previous animation and continues from its current opacity.
export function usePresence<T>(initial: T, dialog = false) {
  const [requested, request] = useState(initial);
  const [shown, show] = useState(initial);
  const ref = useRef<HTMLDivElement>(null);
  const entering = useRef(false);
  const interruptedOpacity = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const element = ref.current;
    const leaving = requested !== shown;
    if (!element) {
      if (leaving) {
        entering.current = true;
        show(() => requested);
      }
      return;
    }
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const finish = () => {
      if (leaving) {
        entering.current = true;
        show(() => requested);
      }
    };
    if (media.matches) {
      interruptedOpacity.current = undefined;
      entering.current = false;
      finish();
      return;
    }
    if (
      !leaving &&
      !entering.current &&
      interruptedOpacity.current === undefined
    )
      return;
    const opacity =
      entering.current && !leaving
        ? "0"
        : (interruptedOpacity.current ?? getComputedStyle(element).opacity);
    interruptedOpacity.current = undefined;
    entering.current = false;
    element.dataset.phase = leaving ? "exit" : "enter";
    const animation = element.animate(
      [{ opacity }, { opacity: leaving ? 0 : 1 }],
      { duration: dialog ? 180 : 160, easing: "ease", fill: "both" },
    );
    const panel = dialog ? element.querySelector(".modal") : null;
    const panelAnimation = panel?.animate(
      leaving
        ? [
            { transform: getComputedStyle(panel).transform },
            { transform: "translateY(6px) scale(.98)" },
          ]
        : [{ transform: "translateY(8px) scale(.98)" }, { transform: "none" }],
      { duration: 300, easing: "cubic-bezier(.16,1,.3,1)", fill: "both" },
    );
    let active = true;
    void Promise.all([animation.finished, panelAnimation?.finished])
      .then(() => {
        if (!active) return;
        delete element.dataset.phase;
        finish();
        if (!leaving) {
          animation.cancel();
          panelAnimation?.cancel();
        }
      })
      .catch(() => {});
    const reduce = () => {
      if (media.matches) {
        animation.finish();
        panelAnimation?.finish();
      }
    };
    media.addEventListener("change", reduce);
    return () => {
      active = false;
      media.removeEventListener("change", reduce);
      // Preserve the current opacity when a rapid navigation interrupts exit.
      interruptedOpacity.current = getComputedStyle(element).opacity;
      animation.cancel();
      panelAnimation?.cancel();
      delete element.dataset.phase;
    };
  }, [requested, shown, dialog]);
  return { shown, request, ref, leaving: requested !== shown };
}
