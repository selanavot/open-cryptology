// Progressive enhancement only; every page works without JS.
(function () {
  "use strict";

  // KaTeX auto-render (loaded deferred from cdnjs only on pages that contain TeX).
  // Falls back to the plain text if the CDN is unavailable.
  function renderTex() {
    if (typeof window.renderMathInElement !== "function") return;
    var opts = {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "\\[", right: "\\]", display: true },
        { left: "$", right: "$", display: false },
        { left: "\\(", right: "\\)", display: false },
      ],
      throwOnError: false,
      ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code", "option", "input"],
    };
    document.querySelectorAll(".tex").forEach(function (el) {
      try {
        window.renderMathInElement(el, opts);
      } catch (e) {
        /* keep plain text */
      }
    });
  }

  // Copy-to-clipboard buttons: <button data-copy="elementId">.
  function setupCopy() {
    document.querySelectorAll("[data-copy]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var el = document.getElementById(btn.getAttribute("data-copy"));
        if (!el || !navigator.clipboard) return;
        navigator.clipboard.writeText(el.textContent.trim()).then(function () {
          var label = btn.querySelector("span") || btn;
          var old = label.textContent;
          label.textContent = "Copied!";
          setTimeout(function () { label.textContent = old; }, 1500);
        });
      });
    });
  }

  // Client-side pre-check for uploads (the server re-checks everything).
  function setupUpload() {
    var form = document.querySelector(".upload-form");
    if (!form) return;
    form.addEventListener("submit", function (ev) {
      var input = form.querySelector('input[type="file"]');
      var f = input && input.files && input.files[0];
      if (f && f.size > 20 * 1024 * 1024) {
        ev.preventDefault();
        alert("PDFs must be 20 MB or smaller.");
      }
    });
  }

  // Navbar search dropdown (<details>): focus the box on open; close on outside click / Escape.
  function setupNavSearch() {
    var d = document.querySelector(".nav-search");
    if (!d) return;
    d.addEventListener("toggle", function () {
      if (d.open) {
        var i = d.querySelector("input");
        if (i) i.focus();
      }
    });
    document.addEventListener("click", function (ev) {
      if (d.open && !d.contains(ev.target)) d.open = false;
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && d.open) {
        d.open = false;
        d.querySelector("summary").focus();
      }
    });
  }

  // Links to /YYYY/NNNN#upload: TeX rendering can shift the layout after the browser's initial
  // jump to the upload box, so jump again (and once more on load, unless the reader has scrolled).
  function scrollToUpload() {
    if (location.hash !== "#upload") return;
    var f = document.getElementById("upload");
    if (!f) return;
    f.scrollIntoView({ block: "start" });
    var y = window.scrollY;
    window.addEventListener("load", function () {
      if (Math.abs(window.scrollY - y) < 2) f.scrollIntoView({ block: "start" });
    });
  }

  // Homepage "Papers by year" card: the ‹ › arrows swap in another year's grid (/__grid/YYYY)
  // instead of going to that year's page. Fragments are kept, so going back is instant.
  function setupGridNav() {
    var card = document.querySelector(".home-missing");
    if (!card || !window.fetch) return;
    var got = {};
    // The fragment URL carries this script's ?v=, so a deploy never mixes old fragments in.
    var ver = ((document.currentScript && document.currentScript.src) || "").split("?")[1] || "";
    function load(year) {
      if (!got[year]) {
        got[year] = fetch("/__grid/" + year + (ver ? "?" + ver : "")).then(function (r) {
          if (!r.ok) throw new Error(r.status);
          return r.text();
        });
        got[year].catch(function () { delete got[year]; });
      }
      return got[year];
    }
    card.addEventListener("click", function (ev) {
      var a = ev.target.closest && ev.target.closest("a.grid-nav[data-grid-year]");
      if (!a || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button) return;
      var cur = card.querySelector(".home-grid");
      if (!cur) return;
      ev.preventDefault();
      var cls = a.classList.contains("prev") ? ".prev" : ".next";
      cur.classList.add("loading");
      load(a.getAttribute("data-grid-year")).then(function (frag) {
        var t = document.createElement("template");
        t.innerHTML = frag.trim();
        var next = t.content.firstElementChild;
        next.classList.add(cls === ".prev" ? "from-prev" : "from-next");
        cur.replaceWith(next);
        // Outline the year's tile, as the year page does.
        var y = next.getAttribute("data-year");
        card.querySelectorAll(".year-tile").forEach(function (tile) {
          var on = tile.getAttribute("href") === "/" + y;
          tile.classList.toggle("sel", on);
          if (on) tile.setAttribute("aria-current", "true");
          else tile.removeAttribute("aria-current");
        });
        var focus = next.querySelector("a.grid-nav" + cls) || next.querySelector("a.grid-nav");
        if (focus) focus.focus({ preventScroll: true });
      }, function () {
        location.href = a.href;
      });
    });
  }

  renderTex();
  scrollToUpload();
  setupGridNav();
  setupCopy();
  setupUpload();
  setupNavSearch();
})();

// Open the contact panel when arriving via #contact or clicking a #contact link.
(function () {
  function openContact() {
    if (location.hash === "#contact") {
      var d = document.getElementById("contact");
      if (d && d.tagName === "DETAILS") d.open = true;
    }
  }
  window.addEventListener("hashchange", openContact);
  openContact();
})();
