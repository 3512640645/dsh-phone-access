(async () => {
  // 勾选首次运行须知并继续，让主界面露出来（仅用于自动截图检查）
  const cb = document.querySelector('input[type=checkbox]');
  if (cb && !cb.checked) {
    cb.click();
    await new Promise((r) => setTimeout(r, 400));
  }
  const btn = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').includes('我已知晓') && !b.disabled);
  if (btn) btn.click();
  await new Promise((r) => setTimeout(r, 2500));
  const dialogs = document.querySelectorAll('[role=dialog],[aria-modal="true"]').length;
  return JSON.stringify({ dismissed: Boolean(btn), remainingDialogs: dialogs });
})()
