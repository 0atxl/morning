// Adapted from Frost's page-vapour.js for React mount/unmount.
// Copyright (c) 2026 0atxl. MIT license: /licenses/frost-vapour.txt.
export function mountPageVapour(page, canvas) {
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const finePointer = matchMedia("(hover: hover) and (pointer: fine)");
  let effect = null;
  let generation = 0;
  let pageHidden = false;
  let disposed = false;

  async function syncEffect() {
    const current = ++generation;
    const enabled =
      !disposed && !pageHidden && !reducedMotion.matches && finePointer.matches;
    if (!enabled) {
      effect?.destroy();
      effect = null;
      canvas.hidden = true;
      return;
    }
    if (effect) return;

    try {
      // Touch and reduced-motion visitors don't download or initialize WebGL.
      const [{ mountVapour }, { createPageScene }] = await Promise.all([
        import("./vapour.js?v=preview-clear-1"),
        import("./page-scene.js?v=preview-clear-1"),
        document.fonts.ready,
      ]);
      if (current !== generation) return;
      canvas.hidden = false;
      effect = mountVapour(canvas, {
        host: page,
        scene: createPageScene(page, canvas),
        intensity: 1,
        lifetime: 1.2,
        refraction: 1,
        flowSpeed: 0.7,
        minRadius: 6,
      });
    } catch {
      // This decoration must never prevent the rest of the page from working.
      if (current === generation) canvas.hidden = true;
    }
  }

  function onPageHide() {
    pageHidden = true;
    void syncEffect();
  }

  function onPageShow() {
    pageHidden = false;
    void syncEffect();
  }

  reducedMotion.addEventListener("change", syncEffect);
  finePointer.addEventListener("change", syncEffect);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);
  void syncEffect();

  return () => {
    disposed = true;
    ++generation;
    effect?.destroy();
    effect = null;
    canvas.hidden = true;
    page.classList.remove("vapour-active");
    reducedMotion.removeEventListener("change", syncEffect);
    finePointer.removeEventListener("change", syncEffect);
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("pageshow", onPageShow);
  };
}
