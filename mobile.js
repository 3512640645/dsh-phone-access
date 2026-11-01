/**
 * DSH 手机端交互增强（只在移动端 UA 下由网关注入，桌面完全不受影响）
 *
 * DSH 侧栏在桌面是常驻分栏；手机上我把它做成覆盖式抽屉，这里补上抽屉该有的行为：
 *   1. 抽屉打开时铺一层遮罩，点遮罩即收起
 *   2. 点了会话行 / 导航行之后立即收起（手机上腾出整屏看内容）
 *   3. 兜底：监听「当前选中的会话」变化，变了也收起
 *   4. 抽屉打开期间锁住背景滚动
 *
 * 注意：不用 setTimeout —— 实测在 DSH 客户端里回调不触发；interval 也可能在重渲染时被
 * 长时间占住，所以这里全部走事件 + MutationObserver 这类不依赖定时器的路径。
 */
(() => {
  if (window.__dshPhoneShell) return;
  window.__dshPhoneShell = true;

  const FRAME = () => document.querySelector('[class*="_frame"]');
  const PANEL = () => document.querySelector('[class*="_sidebarCol"]');
  const expanded = () => {
    const frame = FRAME();
    return Boolean(frame) && frame.getAttribute('data-sidebar-collapsed') !== 'true';
  };

  /** 收起/展开按钮：优先"收起"，避免误选到 DOM 里更靠前的不可见"打开"按钮。 */
  const toggle = () => {
    const buttons = [...(PANEL()?.querySelectorAll('button,[role="button"]') ?? [])];
    const visible = buttons.filter((b) => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const pick = (re) => visible.find((b) => re.test(b.getAttribute('aria-label') ?? b.getAttribute('title') ?? ''));
    return pick(/收起侧边栏|关闭侧边栏/i) ?? pick(/打开侧边栏|展开侧边栏/i);
  };

  const collapse = () => {
    if (!expanded()) return;
    const button = toggle();
    if (button) button.click();
  };

  // ── 遮罩层：只在抽屉展开时出现，点了就收起 ──────────────────────────────
  const backdrop = document.createElement('div');
  backdrop.id = 'dsh-phone-backdrop';
  backdrop.addEventListener('click', collapse);
  document.body.appendChild(backdrop);

  let scrollLocked = false;
  const syncBackdrop = () => {
    const open = expanded();
    backdrop.classList.toggle('dsh-phone-backdrop-on', open);
    if (open !== scrollLocked) {
      document.documentElement.style.overflow = open ? 'hidden' : '';
      scrollLocked = open;
    }
  };

  const frameObserver = new MutationObserver(syncBackdrop);
  const observeFrame = () => {
    const frame = FRAME();
    if (!frame) return false;
    frameObserver.observe(frame, { attributes: true, attributeFilter: ['data-sidebar-collapsed'] });
    syncBackdrop();
    return true;
  };
  if (!observeFrame()) {
    const boot = new MutationObserver(() => { if (observeFrame()) boot.disconnect(); });
    boot.observe(document.documentElement, { childList: true, subtree: true });
  }

  // ── 点会话行/导航行后立即收起（事件驱动，不用定时器） ────────────────────
  // 挂 window 捕获阶段：应用可能在更靠内的节点上 stopPropagation。
  const COLLAPSE_ON = '[class*="sessionRow"], [class*="_panelRow"], [class*="newSession"], [class*="workbenchHome"]';
  const onInteraction = (event) => {
    if (!expanded()) return;
    const target = event.target instanceof Element ? event.target : null;
    const col = PANEL();
    if (!target || !col || !col.contains(target)) return;
    if (target.closest('button[aria-label*="侧边栏"], [class*="_toggle"]')) return;
    if (!target.closest(COLLAPSE_ON)) return;
    collapse();
  };
  window.addEventListener('pointerup', onInteraction, true);
  window.addEventListener('click', onInteraction, true);

  // ── 兜底：选中的会话变了也收起（有些入口不走上面那两类行） ───────────────
  let openSelection = null;
  const selectedSession = () =>
    document.querySelector('[class*="sessionRow"][class*="selecte"]')?.textContent?.trim() ?? '';
  new MutationObserver(() => {
    if (!expanded()) {
      openSelection = null;
      return;
    }
    const selected = selectedSession();
    if (openSelection === null) {
      openSelection = selected;
      return;
    }
    if (selected !== openSelection) {
      openSelection = null;
      collapse();
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
})();
