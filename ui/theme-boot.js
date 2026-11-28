/* 首绘前同步主题，彻底消除暗色主题首帧浅色闪烁与过渡色差（无内联脚本，符合 MV3 CSP） */
(function () {
  try {
    var p = new URLSearchParams(location.search);
    var t = p.has('theme') ? p.get('theme') : localStorage.getItem('guizang_theme');
    if (t && t !== 'system') {
      document.documentElement.dataset.theme = t;
    }
  } catch (e) {}
})();
