import fs from 'node:fs/promises';
import vm from 'node:vm';
import { allowedCourse, decide } from '../core.js';
import { workerTestResults } from './test-extension-worker.mjs';
const fixture = await fs.readFile(new URL('extension-browser-tests.html', import.meta.url), 'utf8');
const pureTests = fixture.slice(fixture.indexOf('const results=[];'), fixture.indexOf('const fixture='));
const context = vm.createContext({ allowedCourse, decide, URL });
new vm.Script(pureTests + '\nglobalThis.pureResults=results;', { filename: 'pure-decision-tests.js' }).runInContext(context);
const all = [...context.pureResults, ...workerTestResults];
const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await fs.readFile(new URL('manifest.json', root), 'utf8'));
const required = [manifest.background.service_worker, manifest.action.default_popup,
  ...manifest.content_scripts.flatMap(c => c.js), 'core.js', 'dom.js', 'popup.css', 'popup.js', 'guide.html', 'guide.css', 'README.md'];
for (const filename of required) await fs.access(new URL(filename, root));
const expectedHosts = ['https://mooc1.chaoxing.com/*', 'https://mooc2-ans.chaoxing.com/*'];
if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(expectedHosts)) throw Error('Unexpected host permissions');
for (const filename of ['worker.js', 'core.js', 'dom.js', 'pulse.js', 'popup.js']) {
  const source = await fs.readFile(new URL(filename, root), 'utf8');
  if (/\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(/.test(source)) throw Error('Unexpected networking primitive: ' + filename);
  if (/\.currentTime\s*=(?!=)/.test(source)) throw Error('Unexpected seek assignment: ' + filename);
}
const report = { passed: all.filter(t => t.ok).length, total: all.length,
  tests: all, staticChecks: ['Manifest file references exist', 'Host permissions restricted to two course origins',
    'No explicit network/upload primitives', 'No currentTime assignment'],
  limitation: 'Real installed-extension integration and browser DOM fixtures have not been executed.' };
console.log(JSON.stringify(report, null, 2));
if (all.some(t => !t.ok)) throw Error('Extension checks failed');
