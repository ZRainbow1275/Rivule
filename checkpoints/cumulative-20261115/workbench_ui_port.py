"""Port the reviewed view/focus behavior, without replacing the cumulative workbench."""
def apply_ui(text, one):
    # Keep structured keys only while their controls belong to the current rendered view.
    anchor = "  const preferenceKey="
    shared = """  const readingNodes=new Map(), activityButtons=new Map(), capabilityHeadings=new Map();
  const sourceControls=new Map();
  const readingKey=item=>['source_id','project_id','task_id','run_id','branch_id'].every(k=>typeof item[k]==='string'&&item[k])?JSON.stringify([item.source_id,item.project_id,item.task_id,item.run_id,item.branch_id]):null;
  function focusKey(nodes){if(document.hidden)return null;for(const [key,node] of nodes)if(node===document.activeElement)return key;return null;}
  function sourceControlKey(source,item,control){const key=readingKey({...item,source_id:source.source_id});return key?JSON.stringify([key,control]):null;}
"""
    text=one(text,anchor,shared+anchor)
    text=one(text,"  function clearWorkbench() {","  function clearWorkbench() {\n    readingNodes.clear();activityButtons.clear();capabilityHeadings.clear();sourceControls.clear();")
    # Capture real DOM focus before removing any old task controls. Removing a focused
    # element first would make document.activeElement point at the body in a browser.
    text=one(text,"controls.hidden = false; items.replaceChildren();","controls.hidden = false;")
    anchor="    if(!selectedItems) return;"
    text=one(text,anchor,anchor+"""
    const previousReading=new Map();
    for(const [key,v] of readingNodes){
      const focused=document.hidden?null:['summary','expand','pending'].find(n=>v[n]&&v[n]===document.activeElement);
      previousReading.set(key,{open:v.facts.open,focused});
    }
    readingNodes.clear();
""")
    text=one(text,"facts.append(make('summary','查看完整内容'));",
             "const summaryControl=make('summary','查看完整内容'),taskKey=readingKey(item),previous=taskKey?previousReading.get(taskKey):null;facts.append(summaryControl);if(previous?.open)facts.open=true;")
    text=one(text,"items.append(card);","""items.append(card);
      if(taskKey){const controls={facts,summary:summaryControl,expand,pending:pendingButton};readingNodes.set(taskKey,controls);if(previous?.focused)controls[previous.focused]?.focus();}
      if(pendingButton)pendingButton.setAttribute('aria-expanded',String(Boolean(facts.open)));""")
    # Activity controls use the same compound identity; labels are not unique across sources.
    text=one(text,"    const activity=el('activity-list');activity.replaceChildren();",
             "    const activityFocus=el('activity-view').hidden?null:focusKey(activityButtons);activityButtons.clear();\n    const activity=el('activity-list');activity.replaceChildren();")
    text=one(text,"activity.append(row);}","activity.append(row);const key=readingKey(item);if(key){activityButtons.set(key,logs);if(key===activityFocus)logs.focus();}}")
    # Preserve keyboard position in secondary sources, including their cumulative pending action.
    text=one(text,"sourceButtons.clear();sourceButtons.set(", "sourceButtons.clear();sourceControls.clear();sourceButtons.set(")
    text=one(text,"  function renderSourceCards(sources){","""  function renderSourceCards(sources){
    const previousSourceControl=focusKey(sourceControls);
    const previousSource=focusKey(sourceButtons);
""")
    text=one(text,"task.append(pending);","task.append(pending);const pk=sourceControlKey(source,item,'pending');if(pk)sourceControls.set(pk,pending);")
    text=one(text,"body.append(task);}","body.append(task);const key=sourceControlKey(source,item,'detail');if(key)sourceControls.set(key,button);}")
    text=one(text,"sourceButtons.set(source.source_id,choose);","sourceButtons.set(source.source_id,choose);sourceControls.set(JSON.stringify([source.source_id,'diagnostic']),diagnostic);")
    anchor="sourceCards.push(card);\n    }\n"
    text=one(text,anchor,anchor+"    if(previousSourceControl)sourceControls.get(previousSourceControl)?.focus();else if(previousSource && previousSource!=='zot-main')sourceButtons.get(previousSource)?.focus();\n")
    # Preserve the richer source evidence text already present on this branch.
    text=one(text,"card.setAttribute('data-state',source.state==='error'?'warning':'unknown');",
        """const proofState=source.connection?.source?.status;
      const warn=source.state==='error'||['stale','revoked','disabled'].includes(proofState)||source.items.some(i=>i.stale||['needs_input','failed'].includes(i.source_status));
      card.setAttribute('data-state',warn?'warning':sourceVerified(source.connection)?'active':'unknown');""")
    # Keep focus through either progress or successful capability view refresh. A whole-view
    # reset clears the map first, so these references cannot carry over to a different read.
    text=one(text,"const box=el('capability-list');box.replaceChildren();",
        "const focused=el('capabilities-view').hidden?null:focusKey(capabilityHeadings);capabilityHeadings.clear();\n    const box=el('capability-list');box.replaceChildren();")
    text=one(text,"box.append(row);\n    }\n  }\n  const deliveryNames=",
        "box.append(row);capabilityHeadings.set(icon,heading);if(icon===focused) heading.focus();\n    }\n  }\n  const deliveryNames=")
    # A completed read must not displace a picker, settings panel or detail the user opened
    # while that read was in flight. Let the normal bounded polling schedule recover afterward.
    text=one(text,"if(pickerDialog.open || (background===true && (el('detail-dialog').open || el('settings').open))){",
        "if(pickerDialog.open || el('detail-dialog').open || el('settings').open){\n        pollEnabled=true;")
    return text

