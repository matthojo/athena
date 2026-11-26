// Athena's landing page: copy buttons, the navigation settling once scrolled,
// and the Ask box typing out what you might ask.
(() => {
  "use strict";

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- Copy buttons on code blocks ----------
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest(".code__copy");
    if (!btn) return;
    const code = btn.parentElement.querySelector("code");
    const label = btn.querySelector("span");
    try {
      await navigator.clipboard.writeText(code.innerText.replace(/\n$/, ""));
      btn.classList.add("is-done");
      label.textContent = "Copied";
    } catch {
      label.textContent = "Select and copy";
    }
    setTimeout(() => {
      btn.classList.remove("is-done");
      label.textContent = "Copy";
    }, 1600);
  });

  // ---------- The home page's navigation settles onto the canvas once scrolled ----------
  const nav = document.querySelector(".site-nav");
  if (nav) {
    const onScroll = () => nav.classList.toggle("is-stuck", window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  // ---------- The Ask box: what you might ask, typed out ----------
  const typed = document.querySelector("[data-typed]");
  if (typed && !reduceMotion) {
    const prompts = [
      "What did Elena say about pricing last month?",
      "Remind me to call Mum on Sunday at 6",
      "I owe Priya the staging plan",
      "Whenever a renewal email comes in, find what I paid last year",
      "Add the Lego Technic Ferrari to Rowan's Christmas gift ideas",
    ];
    let i = 0;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      await sleep(2600);
      for (;;) {
        const text = typed.textContent;
        for (let n = text.length; n >= 0; n--) {
          typed.textContent = text.slice(0, n);
          await sleep(18);
        }
        i = (i + 1) % prompts.length;
        const next = prompts[i];
        await sleep(300);
        for (let n = 1; n <= next.length; n++) {
          typed.textContent = next.slice(0, n);
          await sleep(38 + Math.random() * 40);
        }
        await sleep(2600);
      }
    })();
  }
})();
