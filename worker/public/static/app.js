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

  // Navbar account link. Pages are publicly cached, so the server always renders "Log in"; the
  // display-only oc_login cookie ({n: name, a: photo URL}, set at log-in, never trusted by the
  // server) swaps in the person's photo, or their initials.
  function initialsOf(name) {
    var w = name.trim().split(/\s+/);
    var first = Array.from(w[0] || "?")[0] || "?";
    var last = w.length > 1 ? Array.from(w[w.length - 1])[0] : "";
    return (first + last).toUpperCase();
  }
  function avatarEl(name, photo) {
    var span = document.createElement("span");
    span.className = "avatar";
    span.textContent = initialsOf(name);
    if (!/^https:\/\//.test(photo || "")) return span;
    var img = document.createElement("img");
    img.className = "avatar";
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.onerror = function () { img.replaceWith(span); };
    img.src = photo;
    return img;
  }
  function setupAccountLink() {
    var a = document.querySelector(".nav-account");
    if (!a) return;
    var m = document.cookie.match(/(?:^|;\s*)oc_login=([^;]+)/);
    var info = null;
    try { info = m && JSON.parse(decodeURIComponent(m[1])); } catch (e) { /* ignore a malformed cookie */ }
    if (info && typeof info.n === "string" && info.n) {
      a.textContent = "";
      a.classList.add("has-avatar");
      a.title = info.n;
      a.setAttribute("aria-label", "Your account (" + info.n + ")");
      a.appendChild(avatarEl(info.n, info.a));
    } else if (location.pathname !== "/account") {
      a.href = "/account?next=" + encodeURIComponent(location.pathname + location.search + location.hash);
    }
  }

  // Submit an original manuscript: "+ Add author" / remove rows, and the chosen PDF's name in the
  // drop zone.
  function setupManuscriptForm() {
    var list = document.querySelector(".sb-authors");
    var add = document.querySelector(".sb-add");
    if (list && add) {
      var refresh = function () {
        var rows = list.querySelectorAll(".sb-author");
        rows.forEach(function (r, i) {
          var input = r.querySelector("input");
          input.required = i === 0; // at least one author
          input.setAttribute("aria-label", "Author " + (i + 1));
          r.querySelector(".sb-remove").hidden = rows.length < 2;
        });
      };
      add.hidden = false;
      add.addEventListener("click", function () {
        var row = list.querySelector(".sb-author").cloneNode(true);
        var input = row.querySelector("input");
        input.value = "";
        list.appendChild(row);
        refresh();
        input.focus();
      });
      list.addEventListener("click", function (e) {
        var btn = e.target.closest(".sb-remove");
        if (btn) { btn.closest(".sb-author").remove(); refresh(); }
      });
      refresh();
    }
    var file = document.getElementById("sb-file");
    if (!file) return;
    var drop = file.closest(".sb-drop");
    ["dragenter", "dragover"].forEach(function (t) { drop.addEventListener(t, function () { drop.classList.add("is-over"); }); });
    ["dragleave", "drop"].forEach(function (t) { drop.addEventListener(t, function () { drop.classList.remove("is-over"); }); });
    file.addEventListener("change", function () {
      var f = file.files && file.files[0];
      var name = drop.querySelector(".sb-name");
      if (name) name.textContent = f ? f.name : "Drop a PDF here";
    });
  }

  renderTex();
  setupAccountLink();
  scrollToUpload();
  setupGridNav();
  setupCopy();
  setupUpload();
  setupNavSearch();
  setupManuscriptForm();
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
