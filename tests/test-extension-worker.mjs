import fs from 'node:fs/promises';
import vm from 'node:vm';
import { allowedCourse, decide } from '../core.js';
import { inspectPage, operatePage } from '../dom.js';

const source = (await fs.readFile(new URL('../worker.js', import.meta.url), 'utf8'))
  .replace(/^import[^\n]*\n/gm, '') + '\nthis.hooks = { tick, load, busy: () => busy };';
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const check = (value, message) => { if (!value) throw Error(message); };
const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error: error.message }); }
}
function makeWorker() {
  let now = 10000, uid = 0, listener;
  const calls = [], store = {};
  const media = index => ({ index: 0, paused: true, ended: false, currentTime: 0, duration: 30,
    rate: 2, ready: 4, error: false, taskStatus: 'incomplete' });
  const base = (frameId, documentId, result) => ({ frameId, documentId,
    result: { tasks: [], videos: [], challenge: false, host: false, nextEnabled: false, ...result } });
  let frames = [base(0, 'host', { host: true, nextEnabled: true, pageKey: 'lesson-a' }),
    base(1, 'article-a', { tasks: ['incomplete', 'incomplete'] }),
    base(2, 'video-a', { videos: [media(0)] }), base(3, 'video-b', { videos: [media(1)] })];
  const tab = { id: 7, url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=267281064&chapterId=111' };
  const chrome = {
    storage: { session: { async get(key) { return clone({ [key]: store[key] }); }, async set(obj) { Object.assign(store, clone(obj)); } } },
    tabs: { async get(id) { if (id !== tab.id) throw Error('closed'); return clone(tab); }, onRemoved: { addListener() {} } },
    runtime: { getURL: path => 'chrome-extension://local-test/' + path,
      onMessage: { addListener(fn) { listener = fn; } } },
    alarms: { async create() {}, async clear() {}, onAlarm: { addListener() {} } },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    scripting: { async executeScript(options) {
      if (options.files) return [];
      if (options.func.name === 'inspectPage') return clone(frames);
      const f = frames.find(f => options.target.documentIds?.includes(f.documentId) || options.target.frameIds?.includes(f.frameId));
      if (!f) throw Error('stale document');
      const command = options.args[0];
      calls.push({ frameId: f.frameId, ...clone(command) });
      if (command.kind === 'next') {
        if (command.pageKey !== f.result.pageKey) return [{ result: { ok: false, message: 'stale' } }];
        frames = [base(0, 'host', { host: true, nextEnabled: true, pageKey: 'lesson-b' }),
          base(1, 'article-b', { tasks: ['incomplete'] }), base(4, 'video-c', { videos: [media(0)] })];
      } else {
        const v = f.result.videos[command.index];
        if (!v) return [{ result: { ok: false } }];
        if (command.kind === 'start') v.paused = false;
        if (command.kind === 'pause') v.paused = true;
        if (command.kind === 'speed') v.rate = 2;
      }
      return [{ result: { ok: true } }];
    } }
  };
  class ClockDate extends Date { static now() { return now; } }
  const ctx = vm.createContext({ chrome, allowedCourse, decide, inspectPage, operatePage,
    URL, Date: ClockDate, crypto: { randomUUID: () => 'run-' + ++uid } });
  new vm.Script(source, { filename: 'worker.js' }).runInContext(ctx);
  async function drain() { for (let i = 0; i < 500; i++) await Promise.resolve(); check(!ctx.hooks.busy(), 'worker did not settle'); }
  async function request(message, sender = { url: chrome.runtime.getURL('popup.html') }) {
    const answer = await new Promise(resolve => listener(message, sender, resolve));
    await drain(); return answer;
  }
  return { calls, tab, get frames() { return frames; },
    async start() { return request({ type: 'START', tabId: 7, rate: 2 }); }, request,
    state: () => clone(store.runner), advance(ms = 4000) { now += ms; },
    async tick() { await ctx.hooks.tick(); await drain(); } };
}

await test('后台完整模拟：第一段→第二段→平台确认→下一节→停止', async () => {
  const w = makeWorker(); await w.start();
  check(w.calls.filter(c => c.kind === 'start').length === 1, 'must start only one video');
  w.advance(); await w.tick();
  const first = w.frames.find(f => f.frameId === 2).result.videos[0];
  Object.assign(first, { paused: true, ended: true, currentTime: 30, taskStatus: 'complete' });
  w.frames.find(f => f.frameId === 1).result.tasks[0] = 'complete';
  w.advance(); await w.tick();
  check(w.calls.filter(c => c.kind === 'start').at(-1).frameId === 3, 'must start the lower video');
  const second = w.frames.find(f => f.frameId === 3).result.videos[0];
  Object.assign(second, { paused: true, ended: true, currentTime: 30, taskStatus: 'complete' });
  w.frames.find(f => f.frameId === 1).result.tasks[1] = 'complete';
  w.advance(); await w.tick();
  check(!w.calls.some(c => c.kind === 'next'), 'completion needs a stable observation');
  w.advance(5000); await w.tick();
  check(w.calls.filter(c => c.kind === 'next').length === 1, 'must click next exactly once');
  w.advance(); await w.tick();
  check(w.calls.filter(c => c.kind === 'start').at(-1).frameId === 4, 'must start new chapter');
  await w.request({ type: 'STOP' });
  check(!w.state().running, 'stop must persist');
  check(w.frames.find(f => f.frameId === 4).result.videos[0].paused, 'stop must pause owned media');
  const count = w.calls.length; await w.tick();
  check(w.calls.length === count, 'no work after stop');
});
await test('用户或网站意外暂停后不会强行恢复', async () => {
  const w = makeWorker(); await w.start(); w.advance(); await w.tick();
  Object.assign(w.frames.find(f => f.frameId === 2).result.videos[0], { paused: true, currentTime: 5 });
  w.advance(); await w.tick();
  check(!w.state().running && w.state().message.includes('暂停'), 'must stop on unexpected pause');
  check(w.calls.filter(c => c.kind === 'start').length === 1, 'must not auto-resume paused video');
});
await test('视频结束但平台未确认时不会切换', async () => {
  const w = makeWorker();
  for (const f of w.frames) for (const v of f.result.videos) Object.assign(v, { ended: true, paused: true, currentTime: 30 });
  await w.start(); w.advance(15000); await w.tick();
  check(w.state().running, 'should wait for reporting');
  check(!w.calls.some(c => c.kind === 'next'), 'must never infer task completion from video end');
});
await test('离开指定课程会停止，不操作其他网站', async () => {
  const w = makeWorker(); await w.start(); const count = w.calls.length;
  w.tab.url = 'https://example.com/'; w.advance(); await w.tick();
  check(!w.state().running, 'must stop on different page');
  check(w.calls.length === count, 'must not inject operations on different page');
});
await test('网页不能冒充扩展弹窗发出开始和停止命令', async () => {
  const w = makeWorker();
  const r = await w.request({ type: 'START', tabId: 7 }, { tab: { id: 7 }, frameId: 0, url: w.tab.url });
  check(!r.ok && !w.state()?.running, 'page must not be allowed to start automation');
});
await test('验证或选择题出现时立即停止', async () => {
  const w = makeWorker(); await w.start();
  w.frames.find(f => f.frameId === 1).result.challenge = true;
  w.advance(); await w.tick();
  check(!w.state().running, 'challenge must stop automation');
});
await test('播放长时间没有前进时停止，不能虚报进度', async () => {
  const w = makeWorker(); await w.start(); w.advance(); await w.tick();
  w.advance(50000); await w.tick();
  check(!w.state().running && w.state().message.includes('45秒'), 'stalled media must stop');
});

export const workerTestResults = results;
