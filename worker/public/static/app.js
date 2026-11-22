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

  // Pages without TeX skip KaTeX; a Preview tab loads it on first use (<template id="katex-assets">).
  var texLoading = null;
  function withTex(cb) {
    if (typeof window.renderMathInElement === "function") return cb();
    var t = document.getElementById("katex-assets");
    if (!t) return cb();
    if (!texLoading) {
      texLoading = new Promise(function (done) {
        var nodes = Array.prototype.slice.call(t.content.children);
        (function next() {
          var n = nodes.shift();
          if (!n) return done();
          var el = document.createElement(n.tagName);
          Array.prototype.forEach.call(n.attributes, function (a) { el.setAttribute(a.name, a.value); });
          if (n.tagName === "SCRIPT") { el.onload = next; el.onerror = done; document.head.appendChild(el); }
          else { document.head.appendChild(el); next(); }
        })();
      });
    }
    texLoading.then(cb);
  }

  // Comments (comments.ts), Reddit-like. Pages are cached for everyone, so the server renders the
  // public view: this shows the person's own controls (from /api/me), opens reply and edit boxes,
  // and sends signed-out people to log in when they try to write. The server checks everything.
  function timeAgo(iso) {
    var s = (Date.now() - Date.parse(iso)) / 1000;
    if (!(s >= 0)) return null;
    if (s < 60) return "just now";
    var m = s / 60, h = m / 60, d = h / 24;
    if (m < 60) return Math.floor(m) + "m ago";
    if (h < 24) return Math.floor(h) + "h ago";
    if (d < 30) return Math.floor(d) + "d ago";
    if (d < 365) return Math.floor(d / 30) + "mo ago";
    return Math.floor(d / 365) + "y ago";
  }

  function setupComments() {
    var sec = document.getElementById("comments");
    if (!sec) return;
    var signedIn = /(?:^|;\s*)oc_login=/.test(document.cookie);
    var loginHeading = sec.getAttribute("data-login-heading");
    var tpl = document.getElementById("cm-reply-template");
    // A comment's text before TeX is typeset: the box opened by Edit starts from it.
    var raw = {}, rawTitle = {};
    sec.querySelectorAll(".cm").forEach(function (c) {
      var b = c.querySelector(":scope > .cm-content > .cm-body");
      if (b) raw[c.id] = b.textContent;
      var h = c.querySelector(":scope > .cm-content > .cm-post-title");
      if (h) rawTitle[c.id] = h.textContent;
    });
    sec.querySelectorAll(".cm-time time").forEach(function (t) {
      var rel = timeAgo(t.getAttribute("datetime"));
      if (!rel) return;
      t.title = new Date(t.getAttribute("datetime")).toLocaleString();
      t.textContent = rel;
    });
    // ?comment=<code> only made the redirect skip the cache; keep the address clean.
    if (/[?&]comment=/.test(location.search) && window.history.replaceState) history.replaceState(null, "", location.pathname + location.hash);

    // A comment box: grows with its text; Preview typesets it; Comment is off while it's empty.
    function wire(form, o) {
      var box = form.querySelector("textarea");
      var preview = form.querySelector(".cm-preview");
      var toggle = form.querySelector("[data-preview]");
      var submit = form.querySelector(".cm-submit");
      // An issue or a question needs a title: the box at the top (by its kind) and their edit boxes.
      var title = form.querySelector(".cm-title-input");
      var kindOf = function () {
        var k = form.querySelector('input[name="kind"]:checked');
        return k ? k.value : title ? "issue" : "comment";
      };
      var grow = function () {
        box.style.height = "auto";
        box.style.height = box.scrollHeight + 2 + "px";
        submit.disabled = !box.value.trim() || (kindOf() !== "comment" && !title.value.trim());
      };
      if (title) title.addEventListener("input", grow);
      form.querySelectorAll('input[name="kind"]').forEach(function (k) {
        k.addEventListener("change", function () {
          var kind = kindOf();
          box.placeholder = kind === "issue" ? "What’s wrong, where in the paper, and how serious you think it is"
            : kind === "question" ? "What would you like to know?" : "Add a comment";
          submit.textContent = kind === "comment" ? "Comment" : "Post";
          grow();
          (kind === "comment" ? box : title).focus();
        });
      });
      var write = function () {
        preview.hidden = true;
        box.hidden = false;
        toggle.setAttribute("aria-pressed", "false");
        toggle.textContent = "Preview";
      };
      box.addEventListener("input", grow);
      box.addEventListener("invalid", write);
      toggle.addEventListener("click", function () {
        if (!box.hidden) {
          preview.style.minHeight = box.offsetHeight + "px";
          preview.textContent = box.value.trim();
          box.hidden = true;
          preview.hidden = false;
          toggle.setAttribute("aria-pressed", "true");
          toggle.textContent = "Write";
          withTex(function () { texIn(preview); });
        } else {
          write();
          box.focus();
        }
      });
      form.querySelector(".cm-cancel").addEventListener("click", function () {
        write();
        o.cancel();
      });
      form.addEventListener("submit", function () { submit.disabled = true; });
      grow();
      return { box: box, grow: grow };
    }

    // The box at the top: a one-line pill until it's used. Signed out, using it goes to log in.
    var top = sec.querySelector(".cm-section > .cm-composer");
    if (top) {
      var t = wire(top, {
        cancel: function () {
          t.box.value = "";
          top.reset();
          top.querySelector('input[name="kind"]').dispatchEvent(new Event("change"));
          t.box.blur();
          top.classList.add("is-collapsed");
        },
      });
      top.classList.add("is-collapsed");
      if (!signedIn) {
        t.box.readOnly = true;
        // The log-in pop-up when the page has one (Reply links open it through data-login).
        // Without it, the log-in page; either way, back to these comments afterwards.
        var go = function (e) {
          e.preventDefault();
          var next = location.pathname + "#comments";
          if (!(window.ocLogin && window.ocLogin(loginHeading, next))) location.assign("/account?next=" + encodeURIComponent(next));
        };
        t.box.addEventListener("click", go);
        t.box.addEventListener("keydown", function (e) { if (e.key !== "Tab") go(e); });
      } else {
        var expand = function () { top.classList.remove("is-collapsed"); };
        ["focus", "click", "input"].forEach(function (ev) { t.box.addEventListener(ev, expand); });
      }
    }

    // A reply or edit box under a comment, cloned from the template.
    function openBox(c, kind) {
      var open = c.querySelector(":scope > .cm-content > .cm-composer");
      if (open) {
        if (open.getAttribute("data-kind") === kind) { open.querySelector("textarea").focus(); return; }
        open.querySelector(".cm-cancel").click();
      }
      var form = tpl.content.firstElementChild.cloneNode(true);
      form.setAttribute("data-kind", kind);
      var id = c.id.replace("comment-", "");
      var body = c.querySelector(":scope > .cm-content > .cm-body");
      var box = form.querySelector("textarea");
      if (kind === "edit") {
        form.action = "/comments/" + id + "/edit";
        form.querySelector('input[name="reply_to"]').remove();
        form.querySelector(".cm-submit").textContent = "Save";
        box.value = raw[c.id] || "";
        box.setAttribute("aria-label", "Edit comment");
        if (rawTitle[c.id] !== undefined) {
          var ti = document.createElement("input");
          ti.className = "cm-title-input";
          ti.type = "text";
          ti.name = "title";
          ti.maxLength = 200;
          ti.value = rawTitle[c.id];
          ti.setAttribute("aria-label", "Title");
          box.before(ti);
        }
        body.hidden = true;
        body.after(form);
      } else {
        form.querySelector('input[name="reply_to"]').value = id;
        box.placeholder = "Add a reply";
        box.setAttribute("aria-label", "Add a reply");
        c.querySelector(":scope > .cm-content > .cm-actions").after(form);
      }
      var w = wire(form, {
        cancel: function () {
          form.remove();
          body.hidden = false;
        },
      });
      w.box.focus();
      w.box.setSelectionRange(w.box.value.length, w.box.value.length);
    }

    sec.addEventListener("click", function (e) {
      var el = e.target.closest("[data-reply], [data-share], [data-edit], .cm-line, .cm-expand");
      if (!el) return;
      var c = el.closest(".cm");
      if (el.matches(".cm-line, .cm-expand")) {
        var folded = c.classList.toggle("is-collapsed");
        c.querySelector(".cm-expand").hidden = !folded;
      } else if (el.matches("[data-share]")) {
        var url = location.origin + location.pathname + "#" + c.id;
        var label = el.querySelector("span");
        if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () {
          label.textContent = "Copied";
          setTimeout(function () { label.textContent = "Share"; }, 1500);
        });
      } else if (signedIn) {
        e.preventDefault();
        var menu = el.closest("details");
        if (menu) menu.open = false;
        openBox(c, el.matches("[data-edit]") ? "edit" : "reply");
      }
    });
    document.addEventListener("click", function (e) {
      sec.querySelectorAll(".cm-menu[open]").forEach(function (m) { if (!m.contains(e.target)) m.open = false; });
    });

    // The filter row: All, Issues, Questions, Discussion (top-level posts by kind).
    var filters = sec.querySelector(".cm-filters");
    var thread = sec.querySelector(".cm-thread");
    if (filters) {
      filters.hidden = false;
      filters.addEventListener("click", function (e) {
        var b = e.target.closest(".cm-filter");
        if (!b) return;
        filters.querySelectorAll(".cm-filter").forEach(function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
        thread.setAttribute("data-show", b.getAttribute("data-filter"));
      });
    }

    // Votes. The arrows are forms, so they work without this; here they vote in place. Signed
    // out, they open the log-in pop-up.
    function showVote(form, score, mine) {
      form.querySelector(".cm-score").textContent = score;
      form.classList.toggle("is-up", mine > 0);
      form.classList.toggle("is-down", mine < 0);
      form.querySelector(".cm-up").setAttribute("aria-pressed", mine > 0 ? "true" : "false");
      form.querySelector(".cm-down").setAttribute("aria-pressed", mine < 0 ? "true" : "false");
    }
    sec.addEventListener("submit", function (e) {
      var form = e.target;
      if (!form.matches || !form.matches(".cm-vote") || !e.submitter) return;
      var c = form.closest(".cm");
      if (!signedIn) {
        e.preventDefault();
        var next = location.pathname + "#" + c.id;
        if (!(window.ocLogin && window.ocLogin("Log in or create an account to vote", next))) location.assign("/account?next=" + encodeURIComponent(next));
        return;
      }
      if (!window.fetch || !window.URLSearchParams) return;
      e.preventDefault();
      fetch(form.action, {
        method: "POST",
        credentials: "same-origin",
        headers: { accept: "application/json" },
        body: new URLSearchParams({ vote: e.submitter.value }),
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (d && typeof d.score === "number") showVote(form, d.score, d.vote);
        else if (d && d.error === "signin") location.assign("/account?next=" + encodeURIComponent(location.pathname + "#" + c.id));
      }, function () { /* leave it as it was */ });
    });

    if (!signedIn || !window.fetch) return;
    // The page is cached for everyone: fetch this person's votes, and the scores as they are now.
    fetch("/" + sec.getAttribute("data-target") + "/comments/votes", { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        sec.querySelectorAll(".cm-vote").forEach(function (form) {
          var id = form.closest(".cm").id.replace("comment-", "");
          showVote(form, d.scores[id] || 0, d.mine[id] || 0);
        });
      }, function () { /* the page's scores stay */ });
    fetch("/api/me", { credentials: "same-origin" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      var me = d && d.user;
      if (!me) return;
      var mod = me.role === "maintainer";
      sec.querySelectorAll(".cm[data-owner]").forEach(function (c) {
        var own = c.getAttribute("data-owner") === me.id;
        var menu = c.querySelector(":scope > .cm-content > .cm-actions > .cm-menu");
        var any = false;
        menu.querySelectorAll("[data-can]").forEach(function (it) {
          var can = it.getAttribute("data-can");
          it.hidden = !(can === "own" ? own : mod);
          any = any || !it.hidden;
        });
        menu.hidden = !any;
      });
    }, function () { /* no menus */ });
  }

  setupComments();
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

// "Report a problem" on a paper page links to /contact#paper=2024/123. The id travels in the
// fragment so that crawlers following the link all land on the one /contact address.
(function () {
  var input = document.getElementById("c-paper");
  var m = /^#paper=(\d{4}\/\d{1,6})$/.exec(decodeURIComponent(location.hash));
  if (!input || !m || input.value) return;
  input.value = m[1];
  var topic = document.getElementById("c-topic");
  if (topic && topic.querySelector('option[value="paper"]')) topic.value = "paper";
})();
