// No page data is sent. This heartbeat only wakes our local worker.
(() => {
  if (globalThis.__courseHelperPulseInstalled) return;
  const u = new URL(location.href);
  if ((u.searchParams.get('courseId') || u.searchParams.get('courseid')) !== '267281064') return;
  globalThis.__courseHelperPulseInstalled = true;
  const pulse = () => chrome.runtime.sendMessage({ type: 'PULSE' }).catch(() => {});
  pulse();
  setInterval(pulse, 4000);
})();
