'use strict';
const filter = document.getElementById('source-filter');
if (filter) {
  const updatePreview = () => {
    let total = 0, actions = 0;
    document.querySelectorAll('.task').forEach(task => {
      const visible = filter.value === 'all' || task.dataset.source === filter.value;
      task.hidden = !visible;
      if (visible) {
        total++;
        if (task.dataset.action === 'true') actions++;
      }
    });
    document.getElementById('task-count').textContent = total;
    document.getElementById('action-count').textContent = actions;
    document.getElementById('sidebar-count').textContent = total;
  };
  filter.addEventListener('change', updatePreview);
  // Browsers can restore the previous selection after Back/Forward navigation.
  window.addEventListener('pageshow', updatePreview);
  updatePreview();
}
