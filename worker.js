import { allowedCourse, decide } from './core.js';
import { inspectPage, operatePage } from './dom.js';

const KEY = 'runner';
let busy = false;
let commandQueue = Promise.resolve();
const initial = () => ({ running: false, runId: '', tabId: null, rate: 2,
  message: '打开指定课程的章节页面后，点击开始续播。', counts: null,
  started: {}, speeds: {}, pending: null, wait: null, completeSince: 0 });
const load = async () => (await chrome.storage.session.get(KEY))[KEY] || initial();
const save = state => chrome.storage.session.set({ [KEY]: state });
const isCurrent = async state => {
  const current = await load();
  return current.running && current.runId === state.runId;
};
async function saveCurrent(state) {
  if (await isCurrent(state)) await save(state);
}
function format(seconds) {
  const n = Math.max(0, Math.floor(seconds || 0));
  return Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0');
}
function targetFor(state, video) {
  return video.documentId ? { tabId: state.tabId, documentIds: [video.documentId] } :
    { tabId: state.tabId, frameIds: [video.frameId] };
}
async function act(state, video, command) {
  if (!await isCurrent(state)) return { ok: false, message: '已停止。' };
  const results = await chrome.scripting.executeScript({ target: targetFor(state, video),
    func: operatePage, args: [command] });
  return results[0]?.result || { ok: false, message: '页面控件未响应。' };
}
async function inspect(tabId) {
  const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: inspectPage });
  return results.filter(r => r.result).map(r => ({ ...r.result, frameId: r.frameId,
    documentId: r.documentId || String(r.frameId) }));
}
async function pauseOwned(state) {
  try {
    const tab = await chrome.tabs.get(state.tabId);
    if (!allowedCourse(tab.url)) return;
    const frames = await inspect(state.tabId);
    for (const f of frames) for (const v of f.videos) {
      const key = f.documentId + ':' + v.index;
      if (!v.paused && state.started[key]) {
        await chrome.scripting.executeScript({ target: targetFor(state, f), func: operatePage,
          args: [{ kind: 'pause', index: v.index }] });
      }
    }
  } catch { /* A closed/navigated tab needs no cleanup. */ }
}
async function stop(message = '已停止续播。') {
  const previous = await load();
  await save({ ...previous, running: false, runId: crypto.randomUUID(), message });
  await chrome.alarms.clear('course-pulse');
  await pauseOwned(previous);
  await chrome.action.setBadgeText({ text: '' });
}
async function stopCurrent(state, message) {
  if (await isCurrent(state)) await stop(message);
}

async function tick() {
  if (busy) return;
  busy = true;
  let state;
  try {
    state = await load();
    if (!state.running) return;
    const tab = await chrome.tabs.get(state.tabId);
    if (!allowedCourse(tab.url)) {
      await stopCurrent(state, '标签页已离开指定课程，续播已停止。');
      return;
    }
    const frames = await inspect(state.tabId);
    if (!await isCurrent(state)) return;
    const decision = decide(frames);
    state.counts = decision.counts || state.counts;
    const now = Date.now();
    if (state.pending) {
      const signature = frames.filter(f => f.tasks.length).map(f => f.documentId).sort().join('|');
      if (signature && signature !== state.pending.signature) {
        state.pending = null;
        state.started = {};
        state.speeds = {};
        state.wait = null;
        state.completeSince = 0;
      } else {
        if (now - state.pending.at > 30000) {
          await stopCurrent(state, '切换后未读取到新章节，请检查页面再重新开始。');
        } else {
          state.message = '正在加载下一节…';
          await saveCurrent(state);
        }
        return;
      }
    }
    if (decision.kind === 'stop') {
      await stopCurrent(state, decision.message);
      return;
    }
    if (decision.kind === 'wait') {
      state.completeSince = 0;
      if (!state.wait || state.wait.reason !== decision.reason) state.wait = { reason: decision.reason, at: now };
      const maxWait = decision.reason === 'reporting' ? 90000 : 30000;
      if (now - state.wait.at > maxWait) {
        await stopCurrent(state, decision.reason === 'reporting' ?
          '视频结束后平台仍未确认完成，请检查任务标记。' :
          '未识别到受支持的视频任务页面，请打开具体章节后重新开始。');
      } else { state.message = decision.message; await saveCurrent(state); }
      return;
    }
    state.wait = null;
    if (decision.kind === 'next') {
      if (!state.completeSince) state.completeSince = now;
      if (now - state.completeSince < 4000) {
        state.message = '本页任务已全部完成，准备进入下一节。';
        await saveCurrent(state);
        return;
      }
      await pauseOwned(state);
      state.pending = { at: now, signature: decision.signature };
      state.message = '正在切换下一节…';
      await saveCurrent(state);
      const result = await act(state, decision, { kind: 'next', pageKey: decision.pageKey });
      if (!result.ok) await stopCurrent(state, result.message);
      return;
    }
    state.completeSince = 0;
    const v = decision.video;
    if (decision.kind === 'pause') {
      const result = await act(state, v, { kind: 'pause', index: v.index });
      if (!result.ok) await stopCurrent(state, result.message);
      else { state.message = '本段任务已完成，准备播放下一段。'; await saveCurrent(state); }
      return;
    }
    let record = state.started[v.key];
    if (decision.kind === 'start') {
      if (record?.observedPlaying) {
        await stopCurrent(state, '播放出现暂停，请检查是否需要作答或手动操作，再点击开始。');
        return;
      }
      if (record) {
        if (now - record.requestedAt > 12000) {
          await stopCurrent(state, '浏览器未允许自动播放。请手动点一次视频播放，再点击开始。');
        } else { state.message = '等待播放器开始播放…'; await saveCurrent(state); }
        return;
      }
      state.started[v.key] = { requestedAt: now, observedPlaying: false, lastTime: v.currentTime, lastMovedAt: now };
      state.message = '正在启动下一段视频…';
      await saveCurrent(state);
      const result = await act(state, v, { kind: 'start', index: v.index });
      if (!result.ok) await stopCurrent(state, result.message);
      return;
    }
    if (!record) record = state.started[v.key] = { requestedAt: now, lastTime: v.currentTime, lastMovedAt: now };
    record.observedPlaying = true;
    if (v.currentTime > record.lastTime + 0.05) record.lastMovedAt = now;
    record.lastTime = v.currentTime;
    if (now - record.lastMovedAt > 45000) {
      await stopCurrent(state, '视频超过45秒没有前进，请检查网络或播放器后重新开始。');
      return;
    }
    state.message = '正在播放 ' + format(v.currentTime) + ' / ' + format(v.duration) + ' · ' + v.rate + '倍速';
    if (state.rate && Math.abs(v.rate - state.rate) > 0.01) {
      const speed = state.speeds[v.key] || { attempts: 0, lastRate: null, unchanged: 0 };
      if (speed.lastRate === v.rate) speed.unchanged++;
      else speed.unchanged = 0;
      if (!speed.disabled && speed.attempts < 8 && speed.unchanged < 2) {
        speed.attempts++;
        speed.lastRate = v.rate;
        state.speeds[v.key] = speed;
        await saveCurrent(state);
        const result = await act(state, v, { kind: 'speed', index: v.index, keyboard: speed.unchanged === 1 });
        if (!result.ok) { speed.disabled = true; state.message += '（沿用当前速度）'; }
      } else { speed.disabled = true; state.speeds[v.key] = speed; state.message += '（播放器未切换到所选速度）'; }
    }
    await saveCurrent(state);
  } catch {
    if (state) await stopCurrent(state, '无法读取课程页面。请刷新课程页，手动播放一次后重新开始。');
  } finally { busy = false; }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handle = async () => {
    if (message.type === 'PULSE') {
      const state = await load();
      if (sender.frameId === 0 && sender.tab?.id === state.tabId && state.running) void tick();
      return { ok: true };
    }
    // Only our popup can start, stop or inspect a runner.
    if (sender.tab || !sender.url?.startsWith(chrome.runtime.getURL('popup.html'))) return { ok: false };
    if (message.type === 'STATUS') return { ok: true, state: await load() };
    if (message.type === 'STOP') { await stop(); return { ok: true, state: await load() }; }
    if (message.type === 'START') {
      const tab = await chrome.tabs.get(message.tabId);
      if (!allowedCourse(tab.url)) return { ok: false, message: '请先打开《马克思主义与当代科技》的具体章节页面。' };
      await stop('准备开始…');
      const state = { ...initial(), running: true, runId: crypto.randomUUID(), tabId: tab.id,
        rate: [0, 1, 1.5, 2].includes(message.rate) ? message.rate : 2, message: '正在识别视频任务…' };
      await save(state);
      await chrome.alarms.create('course-pulse', { periodInMinutes: 0.5 });
      await chrome.action.setBadgeBackgroundColor({ color: '#087f73' });
      await chrome.action.setBadgeText({ text: 'ON' });
      // The top-frame pulse also handles an already-open page without reloading it.
      await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ['pulse.js'] });
      void tick();
      return { ok: true, state };
    }
    return { ok: false };
  };
  let operation;
  if (message.type === 'START' || message.type === 'STOP') {
    operation = commandQueue.then(handle);
    commandQueue = operation.catch(() => {});
  } else operation = handle();
  operation.then(sendResponse).catch(async () => {
    if (message.type === 'START') await stop('未能启动续播，请检查课程页后重试。');
    sendResponse({ ok: false, message: '操作未完成，请检查课程标签页后重试。' });
  });
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'course-pulse') void tick(); });
chrome.tabs.onRemoved.addListener(async tabId => {
  const state = await load();
  if (state.tabId === tabId && state.running) await stop('课程标签页已关闭，续播已停止。');
});
