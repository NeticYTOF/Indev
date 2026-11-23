/**
 * Chhotu — IndEV's mascot: a little kilometre stone with a face, a yellow
 * cap and a bolt antenna. Pure decoration: every node built here is
 * aria-hidden, nothing here changes focus, text the app relies on, or
 * layout of existing regions. Moods are CSS classes; speech is a bubble.
 *
 * Honesty rule: Chhotu never states facts the app does not have. Lines
 * are tone only ("on it!", "hmm") — numbers and verdicts stay in the UI.
 */

export type Mood =
  | 'idle' | 'curious' | 'typing' | 'thinking' | 'charging' | 'cheer'
  | 'worried' | 'sleepy' | 'pretend' | 'wink' | 'love' | 'dizzy';

const MOODS: readonly Mood[] = [
  'idle', 'curious', 'typing', 'thinking', 'charging', 'cheer',
  'worried', 'sleepy', 'pretend', 'wink', 'love', 'dizzy',
];

/** The stone body, cap, face and bolt antenna. viewBox 0 0 120 140. */
export function chhotuSvg(extraClass = ''): string {
  return `<svg class="chhotu-svg ${extraClass}" viewBox="0 0 120 140" aria-hidden="true" focusable="false">
  <g class="ch-antenna">
    <path class="ch-stalk" d="M60 22 V8" />
    <path class="ch-bolt" d="M63 -6 L54 6 H60 L56 16 L66 3 H60 Z" />
  </g>
  <g class="ch-body">
    <path class="ch-stone" d="M60 20 C34 20 18 37 18 60 V118 a10 10 0 0 0 10 10 H92 a10 10 0 0 0 10 -10 V60 C102 37 86 20 60 20 Z" />
    <path class="ch-cap" d="M60 20 C34 20 18 37 18 60 H102 C102 37 86 20 60 20 Z" />
    <path class="ch-cap-shine" d="M38 40 C42 33 49 29 56 28" />
    <g class="ch-face">
      <g class="ch-eyes">
        <g class="ch-eye ch-eye-l"><ellipse class="ch-eye-white" cx="44" cy="80" rx="9" ry="10" /><circle class="ch-pupil" cx="44" cy="81" r="4.6" /><circle class="ch-glint" cx="46" cy="78.5" r="1.5" /></g>
        <g class="ch-eye ch-eye-r"><ellipse class="ch-eye-white" cx="76" cy="80" rx="9" ry="10" /><circle class="ch-pupil" cx="76" cy="81" r="4.6" /><circle class="ch-glint" cx="78" cy="78.5" r="1.5" /></g>
        <path class="ch-lid ch-lid-l" d="M34 80 Q44 70 54 80" />
        <path class="ch-lid ch-lid-r" d="M66 80 Q76 70 86 80" />
        <path class="ch-happy ch-happy-l" d="M36 82 Q44 72 52 82" />
        <path class="ch-happy ch-happy-r" d="M68 82 Q76 72 84 82" />
        <path class="ch-heart ch-heart-l" d="M44 88 l-7 -7 a4 4 0 0 1 7 -4 a4 4 0 0 1 7 4 Z" />
        <path class="ch-heart ch-heart-r" d="M76 88 l-7 -7 a4 4 0 0 1 7 -4 a4 4 0 0 1 7 4 Z" />
        <path class="ch-x ch-x-l" d="M38 74 L50 86 M50 74 L38 86" />
        <path class="ch-x ch-x-r" d="M70 74 L82 86 M82 74 L70 86" />
      </g>
      <ellipse class="ch-blush ch-blush-l" cx="31" cy="95" rx="6" ry="3.4" />
      <ellipse class="ch-blush ch-blush-r" cx="89" cy="95" rx="6" ry="3.4" />
      <path class="ch-mouth" d="M50 100 Q60 108 70 100" />
      <path class="ch-mouth-o" d="M60 98 a5 6 0 1 0 0.01 0 Z" />
      <path class="ch-mouth-flat" d="M51 103 H69" />
      <path class="ch-mouth-worry" d="M50 106 Q60 98 70 106" />
    </g>
    <g class="ch-plate"><rect class="ch-plate-bg" x="38" y="112" width="44" height="9" rx="4.5" /><text class="ch-plate-text" x="60" y="119.2" text-anchor="middle">EV 0</text></g>
  </g>
  <g class="ch-sweat"><path d="M98 64 q4 7 0 9 q-4 -2 0 -9 Z" /></g>
  <g class="ch-zzz"><text x="96" y="30">z</text><text x="106" y="18">z</text></g>
</svg>`;
}

export interface MascotHandle {
  root: HTMLElement;
  setMood(mood: Mood, holdMs?: number): void;
  say(line: string, ms?: number): void;
  hop(): void;
  plate(text: string): void;
}

const instances = new Set<MascotHandle>();
let pointerX = -1;
let pointerY = -1;
let lastActivity = 0;
let trackerInstalled = false;

function reduced(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Builds a mascot inside `host`. `size` is a CSS length. */
export function createMascot(host: HTMLElement, opts: { size?: string; bubble?: boolean; plate?: string; name?: string } = {}): MascotHandle {
  const root = document.createElement('div');
  root.className = 'chhotu mood-idle';
  root.setAttribute('aria-hidden', 'true');
  if (opts.size) root.style.setProperty('--ch-size', opts.size);
  root.innerHTML = `<div class="ch-shadow"></div><div class="ch-bob">${chhotuSvg()}</div>${opts.bubble === false ? '' : '<div class="ch-bubble"><span class="ch-bubble-text"></span></div>'}`;
  host.appendChild(root);
  const bubble = root.querySelector<HTMLElement>('.ch-bubble');
  const bubbleText = root.querySelector<HTMLElement>('.ch-bubble-text');
  const plateText = root.querySelector<SVGTextElement>('.ch-plate-text');
  if (plateText && opts.plate) plateText.textContent = opts.plate;

  let baseMood: Mood = 'idle';
  let moodTimer: number | null = null;
  let sayTimer: number | null = null;
  let typeTimer: number | null = null;

  const apply = (mood: Mood): void => {
    for (const m of MOODS) root.classList.toggle(`mood-${m}`, m === mood);
    root.dataset.mood = mood;
  };

  const handle: MascotHandle = {
    root,
    setMood(mood, holdMs) {
      if (moodTimer !== null) { window.clearTimeout(moodTimer); moodTimer = null; }
      if (holdMs && holdMs > 0) {
        apply(mood);
        moodTimer = window.setTimeout(() => { moodTimer = null; apply(baseMood); }, holdMs);
      } else {
        baseMood = mood;
        apply(mood);
      }
    },
    say(line, ms = 3600) {
      if (!bubble || !bubbleText) return;
      if (sayTimer !== null) window.clearTimeout(sayTimer);
      if (typeTimer !== null) window.clearInterval(typeTimer);
      bubble.classList.remove('show');
      void bubble.offsetWidth;
      bubble.classList.add('show');
      if (reduced()) {
        bubbleText.textContent = line;
      } else {
        // Typewriter: characters land one by one (decorative; aria-hidden).
        bubbleText.textContent = '';
        let i = 0;
        typeTimer = window.setInterval(() => {
          i += 1;
          bubbleText.textContent = line.slice(0, i);
          if (i >= line.length && typeTimer !== null) { window.clearInterval(typeTimer); typeTimer = null; }
        }, 22);
      }
      sayTimer = window.setTimeout(() => { bubble.classList.remove('show'); sayTimer = null; }, ms + line.length * 22);
    },
    hop() {
      if (reduced()) return;
      root.classList.remove('hop');
      void root.offsetWidth;
      root.classList.add('hop');
    },
    plate(text) {
      if (plateText) plateText.textContent = text;
    },
  };
  root.addEventListener('animationend', (e) => {
    if ((e as AnimationEvent).animationName === 'ch-hop') root.classList.remove('hop');
  });
  // Petting: click/tap Chhotu for a reaction (pointer only; it is decorative).
  root.addEventListener('pointerdown', () => {
    const pets = Number(root.dataset.pets ?? '0') + 1;
    root.dataset.pets = String(pets);
    handle.hop();
    if (pets % 7 === 0) {
      handle.setMood('dizzy', 1600);
      handle.say(pick(PET_DIZZY));
    } else {
      handle.setMood(pets % 3 === 0 ? 'love' : 'wink', 1100);
      handle.say(pick(PET_LINES), 1800);
    }
  });
  instances.add(handle);
  installTracker();
  return handle;
}

const PET_LINES = [
  'hehe, that tickles',
  'boop received ⚡',
  'charged with friendship',
  'one more and I glow',
  'careful, I’m load-bearing',
  'stone cold? never.',
];
const PET_DIZZY = ['okay okay, stars everywhere', 'too many boops, recalculating me'];

export function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)] as T;
}

/** One shared rAF loop: pupils follow the pointer, idle → sleepy. */
function installTracker(): void {
  if (trackerInstalled || typeof window === 'undefined') return;
  trackerInstalled = true;
  lastActivity = now();
  const wake = (): void => {
    const wasAsleep = now() - lastActivity > SLEEP_MS;
    lastActivity = now();
    if (wasAsleep) {
      instances.forEach((m) => {
        if (m.root.dataset.mood === 'sleepy') {
          m.setMood('idle');
          m.say(pick(['oh! you’re back', 'wasn’t sleeping. was charging.', 'hm? I’m up, I’m up']), 2200);
        }
      });
    }
  };
  window.addEventListener('pointermove', (e) => { pointerX = e.clientX; pointerY = e.clientY; wake(); }, { passive: true });
  window.addEventListener('keydown', wake, { passive: true });
  window.addEventListener('pointerdown', wake, { passive: true });
  if (reduced()) return;
  const SLEEP_MS = 45_000;
  let lastFrame = 0;
  const frame = (t: number): void => {
    requestAnimationFrame(frame);
    if (t - lastFrame < 33) return; // ~30fps is plenty for eyes
    lastFrame = t;
    const idleFor = now() - lastActivity;
    instances.forEach((m) => {
      if (!m.root.isConnected) { instances.delete(m); return; }
      const r = m.root.getBoundingClientRect();
      if (r.width === 0) return;
      let dx = 0;
      let dy = 0;
      if (pointerX >= 0) {
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height * 0.55;
        const ax = pointerX - cx;
        const ay = pointerY - cy;
        const dist = Math.hypot(ax, ay) || 1;
        const reach = Math.min(1, dist / 260);
        dx = (ax / dist) * 3.6 * reach;
        dy = (ay / dist) * 3.2 * reach;
      }
      m.root.style.setProperty('--look-x', `${dx.toFixed(2)}px`);
      m.root.style.setProperty('--look-y', `${dy.toFixed(2)}px`);
      m.root.style.setProperty('--lean', `${(dx * 0.9).toFixed(2)}deg`);
      if (idleFor > SLEEP_MS && m.root.dataset.mood === 'idle') m.setMood('sleepy');
    });
  };
  requestAnimationFrame(frame);
}
