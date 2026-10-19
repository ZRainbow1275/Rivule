'use strict';
let statusTimer;
const status = document.getElementById('copy-status');
document.querySelectorAll('[data-copy]').forEach(button => {
  button.addEventListener('click', async () => {
    const block = document.getElementById(button.dataset.copy);
    if (!block) return;
    clearTimeout(statusTimer);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard_unavailable');
      await navigator.clipboard.writeText(block.textContent);
      status.textContent = '命令已复制';
    } catch {
      // Keep commands visible and selectable when clipboard access is unavailable.
      status.textContent = '复制不可用，请选中下方命令手动复制';
    }
    statusTimer = setTimeout(() => { status.textContent = ''; }, 4000);
  });
});
