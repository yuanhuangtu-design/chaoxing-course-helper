const status = document.querySelector('#status');
const tag = document.querySelector('#state-tag');
const counts = document.querySelector('#counts');
const start = document.querySelector('#start');
const stop = document.querySelector('#stop');
const rate = document.querySelector('#rate');
let settingLoaded = false;
async function message(body) {
  try { return await chrome.runtime.sendMessage(body); }
  catch { return { ok: false, message: '扩展暂未响应，请在扩展管理页面重新加载后再试。' }; }
}
function render(state) {
  tag.textContent = state.running ? '续播中' : '已停止';
  status.textContent = state.message;
  counts.textContent = state.counts ? '本页任务 ' + state.counts.done + ' / ' + state.counts.total + ' 已完成' : '';
  start.disabled = state.running;
  stop.disabled = !state.running;
  if (!settingLoaded) { rate.value = String(state.rate); settingLoaded = true; }
}
async function refresh() {
  const result = await message({ type: 'STATUS' });
  if (result.ok) render(result.state);
  else status.textContent = result.message || '未能读取状态。';
}
start.addEventListener('click', async () => {
  start.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const result = await message({ type: 'START', tabId: tab?.id, rate: Number(rate.value) });
    if (!result.ok) status.textContent = result.message || '未能开始续播。';
    else render(result.state);
  } catch { status.textContent = '请打开课程章节页面后重试。'; }
  finally {
    const result = await message({ type: 'STATUS' });
    if (result.ok) { start.disabled = result.state.running; stop.disabled = !result.state.running; }
    else start.disabled = false;
  }
});
stop.addEventListener('click', async () => {
  const result = await message({ type: 'STOP' });
  if (result.ok) render(result.state);
});
void refresh();
setInterval(refresh, 1200);
