/**
 * Voice — Chhotu's casual, Hinglish-flavoured road-trip lines.
 *
 * These are tone only. They never carry a number, a verdict, or any fact
 * the app has not shown elsewhere; every honesty label (synthetic data,
 * Unknown, warnings) stays in the real UI copy. All of it is rendered
 * aria-hidden, so screen readers hear the precise app text, not banter.
 */
import { pick } from './mascot.js';

export const LINES = {
  hello: [
    'namaste! where are we driving today?',
    'hi! I’m Chhotu. I count kilometres for fun.',
    'kahan chalein? pick a start and an end.',
    'fully charged and ready to roll ⚡',
  ],
  helloAgain: ['welcome back, road buddy!', 'oh hey, you again! where to this time?', 'missed you. the highway did too.'],
  late: ['late-night drive? I’ll keep the headlights on.', 'night owl mode: on. let’s plan.'],
  morning: ['good morning! chai first, then charging.', 'early start? the highway’s empty, nice.'],
  typingFrom: ['ooh, where are we starting?', 'type a town, I’ll find it', 'starting point, got it…'],
  typingTo: ['and where are we headed?', 'destination loading… in my head', 'somewhere nice I hope'],
  picked: ['locked in ✓', 'nice pick!', 'got it, noted on my stone', 'perfect'],
  nowTo: ['nice! now, where to?', 'start locked. destination next!', 'and the finish line is…?'],
  ready: ['all set! set your charge, then hit Plan route', 'both ends locked. let’s gooo', 'ready when you are!'],
  quickRoute: ['classic road trip! pick the exact places ↓', 'ooh, good one. confirm the places from the list'],
  wentOffline: ['uh oh, you’re offline. I’ll wait here'],
  backOnline: ['back online! vroom'],
  noPlaces: ['hmm, I can’t find that. try a nearby town?', 'map says “who?”. try another spelling'],
  swap: ['wheee — flipped!', 'return trip energy', 'A is B, B is A. philosophy.'],
  chargeUp: ['more juice!', 'feeling powerful', 'charge go brrr'],
  chargeDown: ['a little lower…', 'okay, lighter battery', 'easy there'],
  chargeLow: ['uh oh, that’s low. I’ll plan stops early.', 'running on chai fumes here'],
  chargeFull: ['100%! like a fresh phone', 'battery full, heart full'],
  planning: ['crunching kilometres…', 'asking the chargers nicely…', 'drawing the road in my head…', 'checking every stop on the way…'],
  planningLong: ['still on it — long roads take a while', 'patience, chargers are chatty today', 'almost… probably… working on it'],
  planned: ['route ready! shall we?', 'ta-da! here’s your road', 'done! look at that line', 'road trip unlocked 🎉'],
  plannedNoStops: ['no stops needed — straight shot!', 'one go, no chai break needed'],
  plannedManyStops: ['a few chai breaks on this one', 'long one! I picked the stops for you'],
  plannedSynthetic: ['this one’s pretend data — practice drive!', 'demo mode: these chargers are imaginary friends'],
  plannedIncomplete: ['some bits are unknown — read the notes, okay?', 'heads up: not everything checked out. see the notes.'],
  failed: ['oof. that didn’t work. check the note below?', 'hmm, the road said no. let’s fix it', 'uh-oh. one more try?'],
  needPlaces: ['pick both places from the list first!', 'I need a start and an end, boss'],
  saved: ['saved! it’s in your trips now', 'tucked into your trips ✓'],
  unsure: ['hmm, couldn’t confirm that save', 'not sure that saved. let’s double-check'],
  exported: ['downloaded! share it with the gang', 'souvenir exported ✓'],
  copied: ['copied!'],
  offline: ['I can’t reach the server right now. it might still work though', 'server’s being shy. try anyway?'],
  drawerOpen: ['your road diary ✨', 'all your saved trips live here', 'memory lane, but EV'],
  drawerEmpty: ['no trips yet. let’s make some memories!'],
  cancel: ['okay, stopping. no worries'],
  chai: ['CHAI?! ☕ ☕ ☕', 'you said the magic word ☕', 'chai break unlocked ☕'],
} as const;

export type LineKey = keyof typeof LINES;

export function line(key: LineKey): string {
  return pick(LINES[key]);
}

/** Time-of-day greeting key (local clock). */
export function greetingKey(hour: number, returning: boolean): LineKey {
  if (hour >= 23 || hour < 4) return 'late';
  if (hour >= 5 && hour < 10) return 'morning';
  return returning ? 'helloAgain' : 'hello';
}
