(function () {
  const key = "huddle60:theme";
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  let preference = "system";
  try {
    const saved = localStorage.getItem(key);
    if (saved === "light" || saved === "dark") preference = saved;
  } catch (error) {
    console.warn("Unable to read the theme preference.", error);
  }

  function apply() {
    document.documentElement.dataset.theme =
      preference === "system" ? (system.matches ? "dark" : "light") : preference;
    const select = document.getElementById("theme-select");
    if (select) select.value = preference;
  }

  apply();
  system.addEventListener("change", apply);
  window.addEventListener("storage", (event) => {
    if (event.storageArea !== localStorage || (event.key !== key && event.key !== null)) return;
    preference =
      event.newValue === "light" || event.newValue === "dark" ? event.newValue : "system";
    apply();
  });
  document.addEventListener("DOMContentLoaded", () => {
    apply();
    document.getElementById("theme-select").addEventListener("change", (event) => {
      preference = event.target.value;
      apply();
      const status = document.getElementById("theme-status");
      try {
        localStorage.setItem(key, preference);
        status.textContent = "";
      } catch (error) {
        status.textContent = "Unable to save the theme; this choice applies only to this page.";
        console.warn("Unable to save the theme preference.", error);
      }
    });
  });
})();
