// Resolve the preference before styles and React load to avoid a theme flash.
(function () {
  var saved;
  try {
    saved = localStorage.getItem('mcp-console-theme');
  } catch (_) {}
  var mode =
    saved === 'light' || saved === 'dark'
      ? saved
      : window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
  document.documentElement.dataset.theme = mode;
  document.documentElement.style.colorScheme = mode;
  document.querySelector('meta[name="theme-color"]').setAttribute('content', mode === 'dark' ? '#070b13' : '#f3f6fb');
})();
