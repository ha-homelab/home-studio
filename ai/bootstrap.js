import { editorBridge } from '../planner/editor.js';
import { mountAiPanel } from './panel.js';

// Only the companion injects this module and per-tab token. Native HA mounts
// the shared panel through its separate authenticated capability bridge.
const session = document.querySelector('meta[name="home-studio-ai-session"]')?.content;
if (session) {
  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet'; stylesheet.href = new URL('./panel.css', import.meta.url).href;
  document.head.append(stylesheet);
  mountAiPanel(editorBridge, session);
}
