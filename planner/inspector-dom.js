// Reuse controls while refreshing their attributes and handlers. Keeping the
// actual nodes lets native Tab navigation and a pending pointer click finish.
function key(node) {
  if (node.nodeType !== 1) return node.nodeName;
  return node.dataset.inspectorKey || `${node.nodeName}:${node.className}`;
}

export function reconcileInspector(parent, next) {
  const unused = [...parent.childNodes];
  let cursor = parent.firstChild;
  for (const fresh of [...next.childNodes]) {
    const existing = unused.find(node => node.nodeName === fresh.nodeName && key(node) === key(fresh));
    if (!existing || fresh.nodeName === 'CANVAS') {
      parent.insertBefore(fresh, cursor);
      continue;
    }
    unused.splice(unused.indexOf(existing), 1);
    if (existing !== cursor) parent.insertBefore(existing, cursor);
    if (existing.nodeType === 3) existing.nodeValue = fresh.nodeValue;
    else {
      const control = /^(INPUT|SELECT|TEXTAREA)$/.test(existing.nodeName);
      const draft = control && existing.inspectorDraft;
      const value = control ? (draft ? existing.value : fresh.value) : null;
      const invalid = draft && existing.getAttribute('aria-invalid');
      for (const attr of [...existing.attributes]) if (!fresh.hasAttribute(attr.name)) existing.removeAttribute(attr.name);
      for (const attr of fresh.attributes) existing.setAttribute(attr.name, attr.value);
      existing.onclick = fresh.onclick; existing.onchange = fresh.onchange; existing.oninput = fresh.oninput;
      if (existing.nodeName !== 'INPUT' && existing.nodeName !== 'TEXTAREA') reconcileInspector(existing, fresh);
      if (control) {
        if (existing.value !== value) existing.value = value;
        if (invalid) existing.setAttribute('aria-invalid', invalid);
      }
    }
    cursor = existing.nextSibling;
  }
  for (const node of unused) node.remove();
}
