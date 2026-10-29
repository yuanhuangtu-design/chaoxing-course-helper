// Pure decisions: completion comes only from the page's explicit task labels.
export const COURSE_ID = '267281064';
export const ORIGINS = ['https://mooc1.chaoxing.com', 'https://mooc2-ans.chaoxing.com'];

export function allowedCourse(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const course = u.searchParams.get('courseId') || u.searchParams.get('courseid');
    return ORIGINS.includes(u.origin) && course === COURSE_ID &&
      /(?:studentstudy|mycourse\/stu)/.test(u.pathname);
  } catch { return false; }
}

export function decide(frames) {
  const challenge = frames.find(f => f.challenge);
  if (challenge) return { kind: 'stop', message: '页面需要验证或作答，请手动处理后重新开始。' };
  const taskFrames = frames.filter(f => f.tasks.length > 0);
  const tasks = taskFrames.flatMap(f => f.tasks);
  const hosts = frames.filter(f => f.host);
  const host = hosts.find(f => f.frameId === 0) || hosts[0];
  const videos = frames.flatMap(f => f.videos.map(v => ({ ...v, frameId: f.frameId,
    documentId: f.documentId, key: f.documentId + ':' + v.index })))
    .sort((a, b) => a.frameId - b.frameId || a.index - b.index);
  if (!tasks.length) return { kind: 'wait', reason: 'loading', message: '未读取到视频任务标记，等待页面加载。' };
  if (tasks.some(t => t !== 'complete' && t !== 'incomplete')) {
    return { kind: 'stop', message: '任务标记无法识别，已停止，请检查页面。' };
  }
  const counts = { done: tasks.filter(t => t === 'complete').length, total: tasks.length };
  if (tasks.every(t => t === 'complete')) {
    if (!host) return { kind: 'stop', message: '本页任务已完成，但未找到章节切换页面。', counts };
    if (!host.nextEnabled) return { kind: 'stop', message: '本页任务已完成；请回课程目录核对全部任务点。', counts };
    return { kind: 'next', frameId: host.frameId, documentId: host.documentId, pageKey: host.pageKey, counts,
      signature: taskFrames.map(f => f.documentId).sort().join('|') };
  }
  const playing = videos.filter(v => !v.paused && !v.ended);
  if (playing.length > 1) return { kind: 'stop', message: '检测到多个视频同时播放，请先只保留一个视频。', counts };
  if (playing.length === 1 && playing[0].taskStatus === 'complete') {
    return { kind: 'pause', video: playing[0], counts };
  }
  const candidates = videos.filter(v => v.taskStatus !== 'complete' && !v.ended);
  const target = playing[0] || candidates[0];
  if (!target) return { kind: 'wait', reason: 'reporting', message: '视频已结束，等待平台更新任务标记。', counts };
  if (target.error) return { kind: 'stop', message: '播放器报告加载错误，请手动检查后重新开始。', counts };
  return { kind: target.paused ? 'start' : 'playing', video: target, counts };
}
