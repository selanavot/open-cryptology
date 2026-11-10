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

  renderTex();
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
