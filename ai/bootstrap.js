import { editorBridge } from '../planner/editor.js';
import { mountAiPanel } from './panel.js';

// Only the companion injects this module and per-tab token. Static/installed
// viewers never import it and never expose a provider-key entry point.
const session = document.querySelector('meta[name="home-studio-ai-session"]')?.content;
if (session) {
  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet'; stylesheet.href = new URL('./panel.css', import.meta.url).href;
  document.head.append(stylesheet);
  mountAiPanel(editorBridge, session);
}
