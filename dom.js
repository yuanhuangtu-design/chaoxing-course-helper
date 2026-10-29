// These self-contained functions run in the extension's isolated world.
// They read rendered controls and operate player/next-section buttons only.
export function inspectPage() {
  // Ignore utility frames hidden by their parent page.
  try {
    let current = window;
    while (current.frameElement) {
      const element = current.frameElement;
      const owner = current.parent;
      const rect = element.getBoundingClientRect();
      const style = owner.getComputedStyle(element);
      if (!element.getClientRects().length || rect.width <= 0 || rect.height <= 0 ||
          style.display === 'none' || style.visibility === 'hidden') {
        return { tasks: [], videos: [], challenge: false, host: false, nextEnabled: false, pageKey: '' };
      }
      current = owner;
    }
  } catch { /* Cross-origin frames are still restricted by extension permissions. */ }
  const name = el => (el.getAttribute('aria-label') || el.getAttribute('title') ||
    el.querySelector?.('.vjs-control-text')?.textContent || el.textContent || '').trim();
  const visible = el => !!el.getClientRects().length && getComputedStyle(el).display !== 'none' &&
    getComputedStyle(el).visibility !== 'hidden';
  const taskState = el => {
    const n = name(el);
    return n === '任务点已完成' ? 'complete' : n === '任务点未完成' ? 'incomplete' : 'unknown';
  };
  const markerSelector = '[role="option"], [aria-label^="任务点"], [title^="任务点"]';
  const foundMarkers = Array.from(document.querySelectorAll(markerSelector))
    .filter(el => /^任务点/.test(name(el)));
  const markers = foundMarkers.filter(el => !foundMarkers.some(other =>
    other !== el && other.contains(el) && name(other) === name(el)));
  const buttons = Array.from(document.querySelectorAll('button,[role="button"]'));
  const next = buttons.find(el => name(el) === '下一节');
  let parentTask = 'unknown';
  try {
    const container = window.frameElement?.closest('.ans-attach-ct');
    const marker = container && Array.from(container.querySelectorAll(markerSelector))
      .find(el => /^任务点/.test(name(el)));
    if (marker) parentTask = taskState(marker);
  } catch { /* A different origin is handled by the serial fallback. */ }
  const challengeControls = Array.from(document.querySelectorAll(
    'input[type="radio"],input[type="checkbox"],input[autocomplete="one-time-code"],img[alt*="验证码"],[role="dialog"]'));
  const challenge = challengeControls.some(el => visible(el) &&
    (el.matches('input[type="radio"],input[type="checkbox"],input[autocomplete="one-time-code"],img[alt*="验证码"]') ||
      /验证码|人脸|答题|测验|登录|考试/.test(el.innerText || '')));
  return {
    pageKey: (new URL(location.href).searchParams.get('chapterId') || '') + ':' +
      (Array.from(document.querySelectorAll('[role="option"]')).map(name).find(n => n && n !== '正文' && !n.startsWith('任务点')) || ''),
    tasks: markers.map(taskState),
    host: !!next,
    nextEnabled: !!next && visible(next) && !next.disabled && next.getAttribute('aria-disabled') !== 'true',
    challenge,
    videos: Array.from(document.querySelectorAll('video')).map((v, index) => ({
      index, paused: v.paused, ended: v.ended, currentTime: Number(v.currentTime) || 0,
      duration: Number.isFinite(v.duration) ? v.duration : 0, rate: Number(v.playbackRate) || 1,
      ready: v.readyState, error: !!v.error, taskStatus: parentTask
    }))
  };
}

export function operatePage(command) {
  const name = el => (el.getAttribute('aria-label') || el.getAttribute('title') ||
    el.querySelector?.('.vjs-control-text')?.textContent || el.textContent || '').trim();
  if (command.kind === 'next') {
    const key = (new URL(location.href).searchParams.get('chapterId') || '') + ':' +
      (Array.from(document.querySelectorAll('[role="option"]')).map(name).find(n => n && n !== '正文' && !n.startsWith('任务点')) || '');
    if (command.pageKey !== key) return { ok: false, message: '章节在操作前已变化，已停止切换。' };
    const next = Array.from(document.querySelectorAll('button,[role="button"]')).find(el => name(el) === '下一节');
    if (!next || next.disabled || next.getAttribute('aria-disabled') === 'true') return { ok: false, message: '下一节按钮不可用。' };
    next.click();
    return { ok: true };
  }
  const video = document.querySelectorAll('video')[command.index];
  if (!video) return { ok: false, message: '视频控件已变化，请重新开始。' };
  const root = video.closest('[role="region"]') || video.parentElement;
  const buttons = Array.from(root.querySelectorAll('button,[role="button"]'));
  if (command.kind === 'speed') {
    const button = buttons.find(el => /^(播放速度|Playback Rate|Playback Speed)$/.test(name(el)));
    if (!button) return { ok: false, message: '未找到播放器倍速按钮，沿用当前速度。' };
    if (command.keyboard) {
      button.focus();
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      button.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    } else button.click();
    return { ok: true };
  }
  const wantsPause = command.kind === 'pause';
  if ((wantsPause && video.paused) || (!wantsPause && !video.paused)) return { ok: true };
  const button = buttons.find(el => wantsPause ? /^(暂停|Pause)$/.test(name(el)) : /^(播放视频|播放|Play Video|Play)$/.test(name(el)));
  if (!button) return { ok: false, message: '没有识别到播放按钮，请手动点击一次播放。' };
  button.click();
  return { ok: true };
}
