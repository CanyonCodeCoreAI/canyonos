// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

// Turn each <div class="tabs"> into tabs: one button per <div class="tab"
// data-label="...">, showing only the chosen one. Without this script every tab
// still shows, one after another.
(function () {
  document.querySelectorAll("div.tabs").forEach(function (group) {
    var panels = Array.prototype.filter.call(group.children, function (child) {
      return child.classList.contains("tab");
    });
    if (!panels.length) return;

    var bar = document.createElement("div");
    bar.className = "tab-bar";
    bar.setAttribute("role", "tablist");

    function select(index) {
      panels.forEach(function (panel, i) {
        panel.hidden = i !== index;
        bar.children[i].setAttribute("aria-selected", String(i === index));
      });
    }

    panels.forEach(function (panel, i) {
      var button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "tab");
      button.textContent = panel.getAttribute("data-label");
      button.addEventListener("click", function () {
        select(i);
      });
      bar.appendChild(button);
    });

    group.insertBefore(bar, panels[0]);
    group.classList.add("tabs-ready");
    select(0);
  });
})();
