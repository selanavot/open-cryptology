// Progressive enhancement only; every page works without JS.
(function () {
  "use strict";

  // KaTeX auto-render (loaded deferred from cdnjs only on pages that contain TeX).
  // Falls back to the plain text if the CDN is unavailable.
  var TEX_OPTS = {
    delimiters: [
      { left: "$$", right: "$$", display: true },
      { left: "\\[", right: "\\]", display: true },
      { left: "$", right: "$", display: false },
      { left: "\\(", right: "\\)", display: false },
    ],
    throwOnError: false,
    ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code", "option", "input"],
  };
  function texIn(el) {
    if (typeof window.renderMathInElement !== "function") return;
    try {
      window.renderMathInElement(el, TEX_OPTS);
    } catch (e) {
      /* keep plain text */
    }
  }
  function renderTex() {
    document.querySelectorAll(".tex").forEach(texIn);
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
  // Phones: the ☰ menu (a CSS checkbox) closes on a tap outside it, or on Escape.
  function setupNavMenu() {
    var t = document.getElementById("nav-toggle");
    var links = document.querySelector(".nav-links");
    var burger = document.querySelector(".nav-burger");
    if (!t || !links) return;
    document.addEventListener("click", function (ev) {
      if (t.checked && ev.target !== t && !links.contains(ev.target) && !(burger && burger.contains(ev.target))) t.checked = false;
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && t.checked) t.checked = false;
    });
  }

  // Search page: on narrow screens the tips start folded, so results come first.
  function foldSearchTips() {
    var t = document.querySelector("details.search-help");
    if (t && window.matchMedia && window.matchMedia("(max-width: 991.98px)").matches) t.open = false;
  }

  function setupNavSearch() {
    var d = document.querySelector(".nav-search");
    if (!d) return;
    // The full hint doesn't fit a phone-width field; keep the part that teaches the 2024/123 shortcut.
    var field = d.querySelector("input");
    if (field && window.matchMedia && window.matchMedia("(max-width: 575.98px)").matches) field.placeholder = "Search, or go to 2024/123";
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
  // The display-only oc_login cookie ({n: name, a: photo}) says who is logged in, or null.
  function loginInfo() {
    var m = document.cookie.match(/(?:^|;\s*)oc_login=([^;]+)/);
    var info = null;
    try { info = m && JSON.parse(decodeURIComponent(m[1])); } catch (e) { /* ignore a malformed cookie */ }
    return info && typeof info.n === "string" && info.n ? info : null;
  }
  function setupAccountLink() {
    var a = document.querySelector(".nav-account");
    if (!a) return;
    var menu = document.querySelector(".nav-login");
    var info = loginInfo();
    if (info) {
      a.textContent = "";
      a.classList.add("has-avatar");
      a.title = info.n;
      a.setAttribute("aria-label", "Your account (" + info.n + ")");
      a.appendChild(avatarEl(info.n, info.a));
      if (menu) menu.remove();
    } else if (location.pathname !== "/account") {
      a.href = "/account?next=" + encodeURIComponent(location.pathname + location.search + location.hash);
      a.setAttribute("data-login", "");
      if (menu) {
        menu.firstElementChild.href = a.href;
        menu.firstElementChild.setAttribute("data-login", "");
      }
    }
  }

  // Log-in pop-up (the <dialog id="login-dialog"> from layout.ts). Any element with a data-login
  // attribute opens it in place instead of going to the full /account log-in page:
  //
  //   <a href="/account?next=/manuscripts/12" data-login="Log in or create an account to comment">…</a>
  //
  // - data-login is the pop-up's heading; leave it empty for "Log in or create an account".
  // - After logging in (which creates the account the first time) the person lands back on the
  //   link's ?next=, or on the current page when there is none (or the element isn't a link).
  // - Keep the href pointing at /account?next=...: it is what works without JS, on a modifier- or
  //   middle-click, for people already logged in, and on /account itself.
  // - Clicks are delegated from the document, so elements added later work too.
  // - From script: window.ocLogin(heading, next) opens it (both optional); it returns false when
  //   there is no pop-up on the page (logging in isn't switched on).
  function setupLoginDialog() {
    var dlg = document.getElementById("login-dialog");
    if (!dlg || typeof dlg.showModal !== "function") return;
    var title = document.getElementById("login-dialog-title");
    var DEFAULT_TITLE = title.textContent;
    var here = function () { return location.pathname + location.search + location.hash; };
    var returnTo = null;

    function open(heading, next) {
      if (dlg.open) return true;
      title.textContent = (heading || "").trim() || DEFAULT_TITLE;
      dlg.querySelectorAll(".login-buttons a").forEach(function (a) {
        var u = new URL(a.getAttribute("href"), location.origin);
        u.searchParams.set("next", next || here());
        a.setAttribute("href", u.pathname + u.search);
      });
      returnTo = document.activeElement;
      dlg.showModal();
      return true;
    }
    window.ocLogin = function (heading, next) { return open(heading, next); };

    document.addEventListener("click", function (ev) {
      if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      var el = ev.target.closest && ev.target.closest("[data-login]");
      if (!el || dlg.contains(el) || location.pathname === "/account" || loginInfo()) return;
      var next = null;
      if (el.tagName === "A" && el.href) {
        var u = new URL(el.href);
        if (u.origin === location.origin && u.pathname === "/account") next = u.searchParams.get("next");
      }
      ev.preventDefault();
      open(el.getAttribute("data-login"), next);
    });

    dlg.querySelector("[data-login-close]").addEventListener("click", function () { dlg.close(); });
    // A click on the backdrop lands on the <dialog> itself (the card fills it). Both ends of the
    // click must be outside, so a drag that starts on the card doesn't close it.
    var downOutside = false;
    dlg.addEventListener("pointerdown", function (ev) { downOutside = ev.target === dlg; });
    dlg.addEventListener("click", function (ev) {
      if (ev.target === dlg && downOutside) dlg.close();
      downOutside = false;
    });
    // Esc closes the dialog (natively); keep it from also folding the phone menu behind it.
    dlg.addEventListener("keydown", function (ev) { if (ev.key === "Escape") ev.stopPropagation(); });
    dlg.addEventListener("close", function () {
      if (returnTo && returnTo.focus && document.contains(returnTo)) returnTo.focus();
      returnTo = null;
    });
    // Coming back from the provider with the Back button restores the page as it was: closed.
    window.addEventListener("pageshow", function (ev) { if (ev.persisted && dlg.open) dlg.close(); });
  }

  // Submit an original manuscript: "+ Add author" / remove rows, the chosen PDF's name in the
  // drop zone, and Write / Preview for the abstract (Preview typesets it as the manuscript page will).
  function setupManuscriptForm() {
    var abs = document.getElementById("sb-abstract");
    var preview = document.getElementById("sb-abstract-preview");
    var tabs = document.querySelector(".sb-tabs");
    if (abs && preview && tabs) {
      var show = function (which) {
        var previewing = which === "preview";
        if (previewing) {
          var text = abs.value.trim();
          preview.style.minHeight = abs.offsetHeight + "px";
          preview.textContent = text || "Nothing to preview yet.";
          preview.classList.toggle("is-empty", !text);
          if (text) texIn(preview);
        }
        abs.hidden = previewing;
        preview.hidden = !previewing;
        tabs.querySelectorAll(".sb-tab").forEach(function (b) {
          b.setAttribute("aria-pressed", String(b.getAttribute("data-tab") === which));
        });
        if (!previewing) abs.focus();
      };
      tabs.hidden = false;
      tabs.addEventListener("click", function (e) {
        var b = e.target.closest(".sb-tab");
        if (b) show(b.getAttribute("data-tab"));
      });
      // Publishing with an empty abstract while previewing: back to Write so the browser can point at it.
      abs.addEventListener("invalid", function () { if (abs.hidden) show("write"); });
    }
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
  setupLoginDialog();
  scrollToUpload();
  setupGridNav();
  setupCopy();
  setupUpload();
  setupNavSearch();
  foldSearchTips();
  setupNavMenu();
  setupManuscriptForm();
})();

// Old links to the homepage's contact panel (/#contact, /?paper=2024/123#contact): the form
// is its own page now.
(function () {
  function openContact() {
    if (location.hash === "#contact" && !document.getElementById("contact")) location.replace("/contact" + location.search);
  }
  window.addEventListener("hashchange", openContact);
  openContact();
})();
