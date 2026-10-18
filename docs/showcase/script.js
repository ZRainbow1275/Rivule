'use strict';
const filter = document.getElementById('source-filter');
filter.addEventListener('change', () => {
  let total = 0, actions = 0;
  document.querySelectorAll('.task').forEach(task => {
    const visible = filter.value === 'all' || task.dataset.source === filter.value;
    task.hidden = !visible;
    if (visible) { total++; if (task.dataset.action === 'true') actions++; }
  });
  document.getElementById('task-count').textContent = total;
  document.getElementById('action-count').textContent = actions;
});
