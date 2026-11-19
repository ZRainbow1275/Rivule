/** Context for resolving a parent’s links in an already-selected source. */
export function selectedRelationPeers(source) {
  const peers = [];
  for (const item of Array.isArray(source?.items) ? source.items : []) {
    if (!item || (item.source_id !== undefined && item.source_id !== source.source_id)) continue;
    if (item.state === 'available') { peers.push(item); continue; }
    if (!['withheld', 'not_found', 'unavailable'].includes(item.state)) continue;
    const {source_id, project_id, task_id, run_id, branch_id, state} = item;
    if (![source_id, project_id, task_id, run_id, branch_id].every(id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(id))) continue;
    // Unreadable selections contribute identity and read state only, never content.
    peers.push({source_id, project_id, task_id, run_id, branch_id, state});
  }
  return peers;
}
