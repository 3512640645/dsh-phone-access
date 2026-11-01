(async () => {
  const cb = document.querySelector('input[type=checkbox]');
  if (cb && !cb.checked) {
    cb.click();
    await new Promise((r) => setTimeout(r, 400));
  }
  const ack = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').includes('我已知晓') && !b.disabled);
  if (ack) ack.click();
  await new Promise((r) => setTimeout(r, 2500));

  const info = (el, label) => {
    if (!el) return { label, missing: true };
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      label,
      tag: el.tagName.toLowerCase(),
      cls: typeof el.className === 'string' ? el.className : '',
      box: `${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.left)},${Math.round(r.top)}`,
      display: cs.display,
      padding: cs.padding,
      margin: cs.margin,
      gap: cs.gap,
      grid: cs.gridTemplateColumns,
      overflow: `${cs.overflowX}/${cs.overflowY}`,
      fontSize: cs.fontSize,
      chain: (() => {
        const out = [];
        let node = el;
        while (node && node !== document.body && out.length < 6) {
          const c = typeof node.className === 'string' ? node.className.split(/\s+/).filter(Boolean)[0] : '';
          out.push(`${node.tagName.toLowerCase()}${c ? `.${c}` : ''}`);
          node = node.parentElement;
        }
        return out.join(' < ');
      })(),
    };
  };

  const frame = document.querySelector('[data-sidebar-collapsed]');
  const composerEl = document.querySelector('textarea')?.closest('form')
    ?? document.querySelector('textarea')?.parentElement?.parentElement?.parentElement;
  const modeRow = [...document.querySelectorAll('div,button,span,a')].find((e) => (e.textContent || '').trim().startsWith('标准模式') && e.children.length <= 3);

  return JSON.stringify({
    viewport: `${innerWidth}x${innerHeight} dpr=${devicePixelRatio}`,
    body: `${document.body.scrollWidth}x${document.body.scrollHeight}`,
    frameChildren: frame ? [...frame.children].map((c) => info(c, c.className.split(/\s+/)[0] || c.tagName)) : [],
    rail: info(document.querySelector('[data-slot="sidebar"]'), 'rail'),
    composer: info(composerEl, 'composer'),
    composerChain: info(document.querySelector('textarea')?.parentElement, 'textareaParent'),
    modeRow: info(modeRow, 'modeRow'),
    modeRowParent: info(modeRow?.parentElement, 'modeRowParent'),
  }, null, 1);
})()
