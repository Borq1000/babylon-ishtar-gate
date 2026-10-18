import '@fontsource/cormorant-garamond/300.css';
import '@fontsource/cormorant-garamond/400.css';
import '@fontsource/cormorant-garamond/400-italic.css';
import '@fontsource-variable/inter';
import './ui/styles.css';
import { Experience } from './Experience';

const exp = new Experience();
(window as unknown as { babylon: Experience }).babylon = exp;

exp
  .boot(document.getElementById('scene') as HTMLCanvasElement)
  .then(() => {
    (window as unknown as { app: unknown }).app = exp.app;
    (window as unknown as { world: unknown }).world = exp.world;
  })
  .catch((e) => {
    console.error(e);
    const pre = document.createElement('pre');
    pre.style.cssText = 'color:#f88;position:fixed;top:0;left:0;z-index:99;white-space:pre-wrap;font:12px monospace;padding:16px';
    pre.textContent = 'Babylon failed to start:\n' + String(e?.stack ?? e);
    document.body.appendChild(pre);
  });
