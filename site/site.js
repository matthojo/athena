// Athena's project website: search (⌘K), the docs menu on a phone, copy
// buttons, "On this page" tracking and the Ask box on the home page.
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

  // ---------- The docs menu on a phone ----------
  const sidebar = document.getElementById("sidebar");
  const menuBtn = document.querySelector("[data-menu]");
  const scrim = document.querySelector("[data-menu-close]");
  const setMenu = (open) => {
    if (!sidebar || !menuBtn) return;
    sidebar.classList.toggle("is-open", open);
    menuBtn.setAttribute("aria-expanded", String(open));
    if (scrim) scrim.hidden = !open;
    document.body.style.overflow = open ? "hidden" : "";
    if (open) sidebar.querySelector("a, button")?.focus();
  };
  menuBtn?.addEventListener("click", () => setMenu(!sidebar.classList.contains("is-open")));
  scrim?.addEventListener("click", () => setMenu(false));
  sidebar?.addEventListener("click", (e) => {
    if (e.target.closest("a")) setMenu(false);
  });
  window.matchMedia("(min-width: 1024px)").addEventListener("change", () => setMenu(false));

  // ---------- The home page's navigation settles onto the canvas once scrolled ----------
  const nav = document.querySelector(".site-nav");
  if (nav) {
    const onScroll = () => nav.classList.toggle("is-stuck", window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  // ---------- On this page ----------
  const tocLinks = [...document.querySelectorAll(".toc a")];
  if (tocLinks.length && "IntersectionObserver" in window) {
    const byId = new Map(tocLinks.map((a) => [decodeURIComponent(a.hash.slice(1)), a]));
    const headings = [...byId.keys()].map((id) => document.getElementById(id)).filter(Boolean);
    let current = null;
    const setActive = (id) => {
      if (id === current) return;
      current = id;
      for (const a of tocLinks) a.classList.toggle("is-active", a === byId.get(id));
      const active = byId.get(id);
      const toc = document.querySelector(".toc");
      if (active && toc) {
        const top = active.offsetTop - toc.clientHeight / 3;
        toc.scrollTo({ top, behavior: reduceMotion ? "auto" : "smooth" });
      }
    };
    const update = () => {
      let id = headings[0]?.id;
      for (const h of headings) {
        if (h.getBoundingClientRect().top < 120) id = h.id;
        else break;
      }
      setActive(id);
    };
    let ticking = false;
    window.addEventListener(
      "scroll",
      () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
          update();
          ticking = false;
        });
      },
      { passive: true }
    );
    update();
  }

  // ---------- The Ask box: what you might ask, typed out ----------
  const typed = document.querySelector("[data-typed]");
  if (typed && !reduceMotion) {
    const prompts = [
      "What did Gayle say about pricing last month?",
      "Remind me to call Mum on Sunday at 6",
      "I owe Ricardo the staging plan",
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

  // ---------- Search (⌘K) ----------
  const dialog = document.querySelector("dialog.search");
  if (!dialog) return;
  const input = dialog.querySelector(".search__input");
  const results = dialog.querySelector(".search__results");
  const empty = dialog.querySelector(".search__empty");
  let index = null;
  let loading = null;
  let selected = -1;

  const load = () =>
    (loading ??= fetch(new URL("search.json", document.baseURI))
      .then((r) => r.json())
      .then((data) => {
        index = data.map((e) => ({ ...e, hl: e.h.toLowerCase(), xl: e.x.toLowerCase() }));
        run();
      })
      .catch(() => {
        loading = null;
      }));

  const open = () => {
    if (dialog.open) return;
    dialog.showModal();
    input.select();
    load();
  };

  const close = () => dialog.open && dialog.close();

  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-search]")) {
      e.preventDefault();
      open();
    }
  });

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      dialog.open ? close() : open();
    } else if (e.key === "/" && !dialog.open && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) {
      e.preventDefault();
      open();
    } else if (e.key === "Escape" && sidebar?.classList.contains("is-open")) {
      setMenu(false);
      menuBtn?.focus();
    }
  });

  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) close();
  });

  const escape = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const mark = (text, terms) => {
    let out = escape(text);
    for (const t of terms) {
      const re = new RegExp(`(${escape(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
      out = out.replace(re, "<mark>$1</mark>");
    }
    return out;
  };

  const snippet = (entry, terms) => {
    const at = Math.max(0, ...terms.map((t) => entry.xl.indexOf(t)).filter((n) => n >= 0).slice(0, 1));
    const start = Math.max(0, at - 50);
    const text = entry.x.slice(start, start + 180);
    return (start > 0 ? "…" : "") + text + (start + 180 < entry.x.length ? "…" : "");
  };

  const search = (q) => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length || !index) return { terms, hits: [] };
    const hits = [];
    for (const e of index) {
      let score = 0;
      let ok = true;
      for (const t of terms) {
        const inHead = e.hl.includes(t);
        const at = e.xl.indexOf(t);
        if (!inHead && at < 0) {
          ok = false;
          break;
        }
        score += inHead ? 12 : 0;
        if (at >= 0) score += 2 + Math.min(4, e.xl.split(t).length - 1);
      }
      if (!ok) continue;
      if (e.hl.startsWith(terms[0])) score += 6;
      if (e.p === "getting-started" || e.p === "guide") score += 1;
      hits.push({ e, score });
    }
    hits.sort((a, b) => b.score - a.score);
    return { terms, hits: hits.slice(0, 24) };
  };

  const select = (i) => {
    const items = [...results.querySelectorAll(".search__hit")];
    if (!items.length) return;
    selected = (i + items.length) % items.length;
    items.forEach((el, n) => el.setAttribute("aria-selected", String(n === selected)));
    items[selected].scrollIntoView({ block: "nearest" });
  };

  function run() {
    const q = input.value.trim();
    const { terms, hits } = search(q);
    selected = -1;
    empty.hidden = !(q && index && !hits.length);
    if (!hits.length) {
      results.innerHTML = "";
      return;
    }
    // One group per page, pages in the order of their best hit.
    const groups = new Map();
    for (const { e } of hits) {
      if (!groups.has(e.t)) groups.set(e.t, []);
      groups.get(e.t).push(e);
    }
    let html = "";
    for (const [page, entries] of groups) {
      html += `<li class="search__group" role="presentation">${escape(page)}</li>`;
      for (const e of entries) {
        const href = `${e.p}.html${e.a ? `#${e.a}` : ""}`;
        html += `<li role="option"><a class="search__hit" href="${href}"><span class="search__hit-title">${mark(e.h, terms)}</span><span class="search__hit-text">${mark(snippet(e, terms), terms)}</span></a></li>`;
      }
    }
    results.innerHTML = html;
    select(0);
  }

  input.addEventListener("input", run);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      select(selected + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      select(selected - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = results.querySelectorAll(".search__hit")[selected];
      if (hit) {
        close();
        window.location.href = hit.href;
      }
    }
  });
  results.addEventListener("mousemove", (e) => {
    const hit = e.target.closest(".search__hit");
    if (!hit) return;
    const items = [...results.querySelectorAll(".search__hit")];
    const i = items.indexOf(hit);
    if (i !== selected) select(i);
  });
  results.addEventListener("click", (e) => {
    if (e.target.closest(".search__hit")) close();
  });
})();
