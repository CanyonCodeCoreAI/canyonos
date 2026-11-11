// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

// Keep the sidebar where the reader left it. The theme scrolls the current link to
// the top of the sidebar on every page load and every link within a page.
(function () {
  var KEY = "canyonos-sidebar-scroll";
  var sidebar = document.querySelector("div.wy-side-scroll");
  var nav = window.SphinxRtdTheme && window.SphinxRtdTheme.Navigation;
  if (!sidebar || !nav) return;

  // Remember the position when a sidebar link opens another page.
  sidebar.addEventListener("click", function (event) {
    if (!event.target.closest("a")) return;
    try {
      sessionStorage.setItem(KEY, String(sidebar.scrollTop));
    } catch (e) {}
  });

  var saved = null;
  try {
    saved = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
  } catch (e) {}

  // The theme calls reset on page load and on every hash change. Let it mark the
  // current link, then put the sidebar back and only scroll as far as that link needs.
  var reset = nav.reset;
  nav.reset = function () {
    var position = saved !== null ? Number(saved) : sidebar.scrollTop;
    saved = null;
    reset.apply(this, arguments);
    sidebar.scrollTop = position;
    var current = sidebar.querySelector("li.current > a");
    if (current) current.scrollIntoView({ block: "nearest" });
  };
})();
