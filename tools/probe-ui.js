(() => {
  const attr = (el) => [...el.attributes].filter((a) => a.name.startsWith('data-') || a.name === 'role' || a.name === 'aria-label').map((a) => `${a.name}="${a.value.slice(0, 30)}"`).join(' ');
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return `${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.left)},${Math.round(r.top)}`;
  };
  const outline = [];
  const walk = (el, depth) => {
    if (depth > 7 || outline.length > 160) return;
    const cls = typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean).slice(0, 3).join('.') : '';
    const css = getComputedStyle(el);
    outline.push(`${'  '.repeat(depth)}${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls ? `.${cls}` : ''} ${attr(el)} [${box(el)}] ${css.display}/${css.position}${css.overflow !== 'visible' ? ` ovf:${css.overflow}` : ''}`);
    for (const child of el.children) walk(child, depth + 1);
  };
  walk(document.body, 0);

  const dialogs = [...document.querySelectorAll('[role=dialog],[aria-modal="true"]')].map((d) => ({ text: (d.innerText || '').slice(0, 60), box: box(d) }));
  const inputs = [...document.querySelectorAll('input')].map((e) => ({ type: e.type, checked: e.checked, label: (e.closest('label')?.innerText || '').slice(0, 24) }));
  const buttons = [...document.querySelectorAll('button')].map((e) => ({ text: (e.innerText || '').slice(0, 24), disabled: e.disabled }));

  return JSON.stringify({ dialogs, inputs, buttons, outline, viewport: `${innerWidth}x${innerHeight}`, bodyScroll: `${document.body.scrollWidth}x${document.body.scrollHeight}` }, null, 1);
})()
