// Minimal, cinematic UI layer: loading screen, title card, a quiet HUD that
// fades away, tour captions and the exploration hint. Plain DOM, no framework.

import type { QualityLevel } from '../core/Quality';
import type { TimeKey } from '../environment/TimeOfDay';

export interface UIHandlers {
  enter(): void;
  tour(): void;
  explore(): void;
  title(): void;
  time(k: TimeKey): void;
  quality(q: QualityLevel): void;
  sound(on: boolean): void;
}

const TIMES: [TimeKey, string][] = [
  ['morning', 'Morning'],
  ['midday', 'Midday'],
  ['golden', 'Golden Hour'],
  ['night', 'Night'],
];
const QUALITIES: [QualityLevel, string][] = [
  ['low', 'Low'],
  ['high', 'High'],
  ['ultra', 'Ultra'],
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class UI {
  private root: HTMLElement;
  private loader: HTMLElement;
  private loaderBar: HTMLElement;
  private loaderLabel: HTMLElement;
  private title: HTMLElement;
  private hud: HTMLElement;
  private caption: HTMLElement;
  private hint: HTMLElement;
  private fade: HTMLElement;
  private stats: HTMLElement;
  private timeButtons = new Map<TimeKey, HTMLButtonElement>();
  private qualityButtons = new Map<QualityLevel, HTMLButtonElement>();
  private soundButtons: HTMLButtonElement[] = [];
  private modeButtons = new Map<string, HTMLButtonElement>();
  private idleTimer = 0;
  private hidden = false;
  private soundOn = false;
  private captionTimer: number | undefined;
  mode: 'title' | 'tour' | 'explore' = 'title';

  constructor(private h: UIHandlers) {
    this.root = document.getElementById('ui')!;

    // ---- loading screen
    this.loader = el('div', 'loader');
    const lt = el('div', 'loader-inner');
    lt.append(el('div', 'brand', 'BABYLON'), el('div', 'brand-sub', 'The Ishtar Gate — 575 BCE'));
    const bar = el('div', 'loader-track');
    this.loaderBar = el('div', 'loader-bar');
    bar.append(this.loaderBar);
    this.loaderLabel = el('div', 'loader-label', 'Preparing the city');
    lt.append(bar, this.loaderLabel);
    this.loader.append(lt);

    // ---- title card
    this.title = el('div', 'title hidden');
    const tc = el('div', 'title-copy');
    tc.append(
      el('div', 'eyebrow', 'Nebuchadnezzar II · Neo-Babylonian Empire'),
      el('h1', 'brand big', 'BABYLON'),
      el('div', 'brand-sub big', 'The Ishtar Gate — 575 BCE'),
      el('p', 'lede', 'Walk the Processional Way between sixty glazed lions per wall, towards the gate of the goddess Ishtar, as the Akitu procession carries the god into the city at the end of the day.'),
    );
    const actions = el('div', 'title-actions');
    const enter = el('button', 'btn primary', 'Enter Babylon');
    enter.onclick = () => h.enter();
    const tourB = el('button', 'btn', 'Cinematic Tour');
    tourB.onclick = () => h.tour();
    const expB = el('button', 'btn', 'Explore');
    expB.onclick = () => h.explore();
    actions.append(enter, tourB, expB);
    tc.append(actions);
    const settings = el('div', 'title-settings');
    settings.append(this.segmented('Time of Day', TIMES, (k) => h.time(k), this.timeButtons));
    settings.append(this.segmented('Graphics Quality', QUALITIES, (q) => h.quality(q), this.qualityButtons));
    const sound = this.soundControl();
    settings.append(sound);
    tc.append(settings);
    this.title.append(tc);
    const foot = el('div', 'title-foot');
    foot.append(el('span', '', 'An interactive historical reconstruction · artistic interpretation where evidence is lacking'));
    this.title.append(foot);

    // ---- HUD (during the experience)
    this.hud = el('div', 'hud hidden');
    const left = el('div', 'hud-group');
    const back = el('button', 'hud-btn', 'BABYLON');
    back.title = 'Back to the title';
    back.onclick = () => h.title();
    left.append(back);
    const modes = el('div', 'hud-group');
    for (const [k, label, fn] of [
      ['tour', 'Cinematic Tour', () => h.tour()],
      ['explore', 'Explore', () => h.explore()],
    ] as [string, string, () => void][]) {
      const b = el('button', 'hud-btn', label);
      b.onclick = fn;
      this.modeButtons.set(k, b);
      modes.append(b);
    }
    const times = el('div', 'hud-group');
    for (const [k, label] of TIMES) {
      const b = el('button', 'hud-btn small', label);
      b.onclick = () => h.time(k);
      this.timeButtons.set(k, b);
      times.append(b);
    }
    const right = el('div', 'hud-group');
    const snd = el('button', 'hud-btn', 'Sound: off');
    snd.onclick = () => this.toggleSound();
    this.soundButtons.push(snd);
    const qual = el('div', 'hud-group');
    for (const [k, label] of QUALITIES) {
      const b = el('button', 'hud-btn small', label);
      b.onclick = () => h.quality(k);
      this.qualityButtons.set(k, b);
      qual.append(b);
    }
    const hide = el('button', 'hud-btn', 'Hide UI');
    hide.title = 'Hide the interface (H)';
    hide.onclick = () => this.setHidden(true);
    right.append(snd, hide);
    this.hud.append(left, modes, times, qual, right);

    this.caption = el('div', 'caption');
    this.hint = el('div', 'hint hidden');
    this.hint.replaceChildren(
      el('div', 'hint-title', 'Click to look around'),
      el('div', 'hint-keys', 'W A S D — walk · Shift — hurry · Mouse — look · Esc — release · H — hide UI'),
    );
    this.fade = el('div', 'fade');
    this.stats = el('div', 'stats hidden');
    this.root.append(this.title, this.hud, this.caption, this.hint, this.stats, this.fade, this.loader);

    window.addEventListener('mousemove', () => this.poke());
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyH') this.setHidden(!this.hidden);
      if (e.code === 'KeyP') this.stats.classList.toggle('hidden');
      this.poke();
    });
  }

  private segmented<K extends string>(label: string, items: [K, string][], fn: (k: K) => void, store: Map<K, HTMLButtonElement>): HTMLElement {
    const wrap = el('div', 'seg');
    wrap.append(el('div', 'seg-label', label));
    const row = el('div', 'seg-row');
    for (const [k, text] of items) {
      const b = el('button', 'seg-btn', text);
      b.onclick = () => fn(k);
      row.append(b);
      // keep both the title and HUD buttons in sync: store the first, mark the others by data attr
      if (!store.has(k)) store.set(k, b);
      b.dataset.key = k;
      b.dataset.group = label;
    }
    wrap.append(row);
    return wrap;
  }

  private soundControl(): HTMLElement {
    const wrap = el('div', 'seg');
    wrap.append(el('div', 'seg-label', 'Sound'));
    const row = el('div', 'seg-row');
    const b = el('button', 'seg-btn', 'Off');
    b.onclick = () => this.toggleSound();
    this.soundButtons.push(b);
    row.append(b);
    wrap.append(row);
    return wrap;
  }

  private toggleSound(): void {
    this.soundOn = !this.soundOn;
    this.h.sound(this.soundOn);
    this.setSound(this.soundOn);
  }

  setSound(on: boolean): void {
    this.soundOn = on;
    for (const b of this.soundButtons) {
      b.textContent = b.classList.contains('hud-btn') ? `Sound: ${on ? 'on' : 'off'}` : on ? 'On' : 'Off';
      b.classList.toggle('active', on);
    }
  }

  setTime(k: TimeKey): void {
    document.querySelectorAll<HTMLButtonElement>('[data-group="Time of Day"]').forEach((b) => b.classList.toggle('active', b.dataset.key === k));
    for (const [kk, b] of this.timeButtons) b.classList.toggle('active', kk === k);
  }

  setQuality(q: QualityLevel): void {
    document.querySelectorAll<HTMLButtonElement>('[data-group="Graphics Quality"]').forEach((b) => b.classList.toggle('active', b.dataset.key === q));
    for (const [kk, b] of this.qualityButtons) b.classList.toggle('active', kk === q);
  }

  setProgress(f: number, label: string): void {
    this.loaderBar.style.transform = `scaleX(${Math.max(0.02, Math.min(1, f))})`;
    this.loaderLabel.textContent = label;
  }

  ready(): void {
    this.loader.classList.add('done');
    setTimeout(() => this.loader.remove(), 1600);
    this.showTitle();
  }

  showTitle(): void {
    this.mode = 'title';
    this.title.classList.remove('hidden');
    this.hud.classList.add('hidden');
    this.hint.classList.add('hidden');
  }

  showExperience(mode: 'tour' | 'explore'): void {
    this.mode = mode;
    this.title.classList.add('hidden');
    this.hud.classList.toggle('hidden', this.hidden);
    for (const [k, b] of this.modeButtons) b.classList.toggle('active', k === mode);
    this.setHint(mode === 'explore');
    this.poke();
  }

  setHint(show: boolean): void {
    this.hint.classList.toggle('hidden', !show || this.hidden);
  }

  setHidden(h: boolean): void {
    this.hidden = h;
    this.root.classList.toggle('ui-hidden', h);
    if (this.mode !== 'title') this.hud.classList.toggle('hidden', h);
  }

  /** Short cinematic caption (tour chapters). */
  showCaption(text: string): void {
    this.caption.textContent = text;
    this.caption.classList.add('show');
    clearTimeout(this.captionTimer);
    this.captionTimer = window.setTimeout(() => this.caption.classList.remove('show'), 4200);
  }

  /** Fade to black and back around an action (cuts). */
  async fadeCut(action: () => void, ms = 650): Promise<void> {
    this.fade.classList.add('on');
    await new Promise((r) => setTimeout(r, ms));
    action();
    await new Promise((r) => setTimeout(r, 120));
    this.fade.classList.remove('on');
  }

  setStats(text: string): void {
    if (!this.stats.classList.contains('hidden')) this.stats.textContent = text;
  }

  private poke(): void {
    this.hud.classList.remove('idle');
    this.idleTimer = 0;
  }

  update(dt: number, pointerLocked: boolean): void {
    this.idleTimer += dt;
    if (this.mode !== 'title' && (this.idleTimer > 3.2 || pointerLocked)) this.hud.classList.add('idle');
    if (this.mode === 'explore') this.setHint(!pointerLocked);
  }
}
