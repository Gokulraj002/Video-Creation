import type { GenreProfile } from '../../genres';
import type { RequestDigest } from '../../stages';
import { capitalize, clip, limitWords, sentence, sentences, words } from '../../util/text';

// =============================================================================================
// Deterministic randomness
// =============================================================================================

/** 32-bit FNV-1a hash. */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Small seeded PRNG (mulberry32). */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Float in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  int(maxExclusive: number): number {
    return Math.floor(this.next() * Math.max(1, maxExclusive));
  }

  pick<T>(items: readonly [T, ...T[]]): T {
    return items[this.int(items.length)] ?? items[0];
  }
}

// =============================================================================================
// Request analysis
// =============================================================================================

export type CartoonCharacter = 'blob' | 'robot' | 'cat' | 'bird';
export type CartoonSetting = 'room' | 'office' | 'park' | 'space' | 'stage';

export interface TopicAnalysis {
  title: string;
  /** Key messages extracted from the prompt (≥ 1). */
  messages: [string, ...string[]];
  callToAction: string | null;
  /** Procedure steps (numbered/bulleted lines of the prompt, or sensible generic steps). */
  steps: [string, ...string[]];
  cautions: string[];
  features: string[];
  location: string | null;
  price: string | null;
  contact: string | null;
  /** Sentences that contain a number (for stat counters). */
  numericFacts: string[];
  character: CartoonCharacter | null;
  setting: CartoonSetting | null;
}

const CTA_HINT =
  /\b(call|visit|book|buy|order|shop|sign up|subscribe|download|register|join|contact|learn more|get started|try it|try now|follow|apply|reserve|schedule)\b/i;
const CAUTION_HINT = /\b(caution|warning|danger|careful|never|do not|don't|avoid|ensure|safety|protective|hazard)\b/i;
const STEP_LINE = /^\s*(?:step\s*\d+\s*[:.)-]?|\d+\s*[.)]|[-*•])\s+(.+)$/gim;
const PRICE = /(?:[$€£₹]\s?\d[\d,.]*\s?(?:k|m|million|lakh|crore)?|\d[\d,.]*\s?(?:USD|EUR|GBP|INR))/i;
const FEATURE =
  /\b\d+(?:[.,]\d+)?\s?(?:-|\s)?(?:bed(?:room)?s?|bath(?:room)?s?|car garage|sq\.?\s?ft|square (?:feet|meters|metres)|m²|sqm|acres?|floors?|stor(?:y|ies))\b/gi;
const AMENITIES = [
  'pool',
  'garden',
  'garage',
  'balcony',
  'terrace',
  'fireplace',
  'ocean view',
  'sea view',
  'lake view',
  'mountain view',
  'gym',
  'parking',
  'rooftop',
  'open-plan kitchen',
  'hardwood floors',
  'smart home',
  'walk-in closet',
  'home office',
];
const LOCATION = /\b(?:in|at|located in|near)\s+((?:[A-Z][\w'’-]*)(?:(?:\s|,\s?)(?:[A-Z][\w'’-]*)){0,3})/;
const CONTACT = /\b(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+\.(?:com|net|org|io|co|ai|app|dev|shop|store|in|uk|de|fr)(?:\/[^\s]*)?\b|\+?\d[\d\s().-]{7,}\d/i;
const NUMBER = /\d/;

const CHARACTER_HINTS: readonly [RegExp, CartoonCharacter][] = [
  [/\b(cat|cats|kitten|kitty)\b/i, 'cat'],
  [/\b(robot|robots|android|bot|machine)\b/i, 'robot'],
  [/\b(bird|birds|parrot|penguin|chicken|duck|owl)\b/i, 'bird'],
  [/\b(blob|slime|jelly|monster)\b/i, 'blob'],
];
const SETTING_HINTS: readonly [RegExp, CartoonSetting][] = [
  [/\b(office|work|meeting|boss|desk)\b/i, 'office'],
  [/\b(space|planet|moon|rocket|alien|galaxy)\b/i, 'space'],
  [/\b(park|garden|forest|outdoors|picnic)\b/i, 'park'],
  [/\b(stage|show|concert|theater|theatre|talent)\b/i, 'stage'],
  [/\b(room|home|house|kitchen|bedroom|apartment)\b/i, 'room'],
];

function genericMessages(title: string, profile: GenreProfile): [string, ...string[]] {
  const t = clip(title, 120);
  switch (profile.genre) {
    case 'sop-training':
    case 'corporate-training':
      return [`Why ${t} matters`, `How to do ${t} correctly`, `Common mistakes to avoid`, `Key takeaways`];
    case 'comedy':
    case 'cartoon':
      return [`${t} seemed like a simple idea`, `Then everything went hilariously wrong`, `It all worked out in the end`];
    case 'real-estate':
      return [`${t} offers space, light and comfort`, `Every room is designed for modern living`, `A location that has it all`];
    case 'product-3d':
    case 'promo':
    case 'cinematic-ad':
      return [`${t} is designed to stand out`, `Built with care in every detail`, `Made for the way you live`];
    default:
      return [`What ${t} is`, `How ${t} works`, `Why ${t} matters`];
  }
}

function genericSteps(title: string): [string, ...string[]] {
  const t = clip(title, 80);
  return [
    `Read the ${t} checklist and put on the required protective equipment`,
    'Prepare and inspect the work area',
    'Gather the tools and materials listed for the task',
    'Perform the main operation slowly and deliberately',
    'Check the result against the quality standard',
    'Clean the area and record the completed task',
  ];
}

function nonEmpty<T>(items: T[], fallback: [T, ...T[]]): [T, ...T[]] {
  const [first, ...rest] = items;
  return first === undefined ? fallback : [first, ...rest];
}

/** Extracts topic material from the request (pure, deterministic). */
export function analyzeRequest(request: RequestDigest, profile: GenreProfile): TopicAnalysis {
  const text = request.prompt;
  const all = sentences(text);
  const messageCandidates = all
    .filter((s) => words(s).length >= 3)
    .map((s) => clip(s, 300))
    .filter((s, i, arr) => arr.indexOf(s) === i);
  const ctaSentence = all.find((s) => CTA_HINT.test(s));

  const steps: string[] = [];
  for (const match of text.matchAll(STEP_LINE)) {
    const step = match[1]?.trim();
    if (step && words(step).length >= 2) steps.push(clip(step.replace(/[.;]+$/, ''), 300));
  }

  const features: string[] = [];
  for (const match of text.matchAll(FEATURE)) features.push(clip(match[0], 120));
  const lower = text.toLowerCase();
  for (const amenity of AMENITIES) {
    if (lower.includes(amenity)) features.push(capitalize(amenity));
  }

  const location = LOCATION.exec(text)?.[1] ?? null;
  const price = PRICE.exec(text)?.[0]?.trim().replace(/[.,]+$/, '') ?? null;
  const contact = CONTACT.exec(text)?.[0]?.trim() ?? null;
  const haystack = `${request.title} ${text}`;

  return {
    title: request.title,
    messages: nonEmpty(
      messageCandidates.filter((m) => m !== ctaSentence).slice(0, 8),
      genericMessages(request.title, profile),
    ),
    callToAction: ctaSentence ? clip(ctaSentence.replace(/[.!]+$/, ''), 200) : null,
    steps: nonEmpty(steps.slice(0, 60), genericSteps(request.title)),
    cautions: all.filter((s) => CAUTION_HINT.test(s)).map((s) => clip(s, 200)),
    features: features.filter((f, i, arr) => arr.indexOf(f) === i).slice(0, 6),
    location: location ? clip(location.replace(/[,\s]+$/, ''), 160) : null,
    price: price ? price.slice(0, 40) : null,
    contact: contact ? clip(contact, 160) : null,
    numericFacts: messageCandidates.filter((s) => NUMBER.test(s)).slice(0, 10),
    character: CHARACTER_HINTS.find(([re]) => re.test(haystack))?.[1] ?? null,
    setting: SETTING_HINTS.find(([re]) => re.test(haystack))?.[1] ?? null,
  };
}

// =============================================================================================
// Beats → copy
// =============================================================================================

const BEAT_OPENERS: Readonly<Record<string, string>> = {
  hook: 'Picture this.',
  tension: 'But something is missing.',
  reveal: 'Now, the reveal.',
  desire: 'Imagine it in your hands.',
  payoff: 'This is {title}.',
  problem: 'Here is the problem.',
  benefit: 'Here is the benefit.',
  proof: 'And the results speak for themselves.',
  offer: 'Ready to start?',
  step: 'Next step.',
  check: 'Now check your work.',
  'why it matters': 'Why does this matter?',
  concept: 'The key idea is simple.',
  example: 'Here is an example.',
  practice: "Let's put it into practice.",
  recap: "Let's recap.",
  setup: "So, here's the situation.",
  escalation: 'And then it got worse.',
  punchline: "And that's when it clicked.",
  introduction: 'Meet our hero.',
  discovery: 'One day, something unexpected appeared.',
  mishap: 'Uh-oh. That did not go as planned.',
  chase: 'And so the chase began!',
  gag: 'Of course, nothing is ever that simple.',
  resolution: 'In the end, everything worked out.',
  statement: 'Say it loud.',
  data: 'Look at the numbers.',
  idea: "Here's the idea.",
  'design detail': 'Every detail is intentional.',
  feature: 'Take a closer look.',
  hero: 'This is {title}.',
  arrival: 'Welcome home.',
  'living spaces': 'Step inside the living spaces.',
  kitchen: 'The kitchen is made for gathering.',
  bedrooms: 'Retreat to the bedrooms.',
  amenities: 'And the amenities?',
  neighborhood: 'Step outside into the neighborhood.',
  question: 'Ever wondered how this works?',
  'how it works': "Here's how it works.",
  agenda: "Here's what we'll cover.",
  context: 'First, some context.',
  insight: "Here's the key insight.",
  recommendation: 'Our recommendation is clear.',
  twist: "But wait, there's a twist.",
  value: "Here's what you get.",
  story: "Here's the story.",
  evidence: 'The evidence is clear.',
  perspective: "Let's look at it from another angle.",
  reflection: 'So what does it all mean?',
  detail: 'Notice the details.',
  opening: 'Welcome to {title}.',
  closing: 'That is {title}.',
};

const BEAT_VISUALS: Readonly<Record<string, string>> = {
  hook: 'A striking opening image that grabs attention instantly',
  tension: 'Shadows and tight framing build anticipation',
  reveal: 'The subject emerges into the light',
  desire: 'Lingering close-ups of textures and details',
  payoff: 'A confident hero frame of the subject',
  problem: 'A relatable frustration shown simply',
  benefit: 'The benefit shown in action',
  proof: 'Big numbers and social proof fill the frame',
  offer: 'A clean offer card with a clear button',
  step: 'A clear close-up of the hands performing the action',
  check: 'An inspection of the finished work against the standard',
  'why it matters': 'A real workplace moment that shows the stakes',
  concept: 'A simple diagram that makes the idea concrete',
  example: 'A realistic example scenario',
  practice: 'A colleague applying the concept step by step',
  recap: 'Key points stacked into a tidy summary',
  setup: 'The character in a perfectly ordinary situation',
  escalation: 'The situation spirals with exaggerated reactions',
  punchline: 'A smash cut to the absurd payoff',
  introduction: 'Our hero waves hello in a bright cartoon world',
  discovery: 'A curious object appears with a sparkle',
  mishap: 'A comic accident with flying props',
  chase: 'A frantic chase across the scene',
  gag: 'A classic visual gag with squash and stretch',
  resolution: 'Everyone celebrates together',
  statement: 'Oversized kinetic type fills the frame',
  data: 'Animated figures counting up',
  idea: 'Abstract shapes morph into the idea',
  'design detail': 'Macro detail of materials and finish',
  feature: 'A feature callout floating beside the product',
  hero: 'The hero product rotating under studio light',
  arrival: 'A golden-hour exterior establishing shot',
  'living spaces': 'A slow glide through the bright living room',
  kitchen: 'Sunlight across the kitchen counters',
  bedrooms: 'A calm, airy bedroom with soft linens',
  amenities: 'Amenities showcased one after another',
  neighborhood: 'Aerial view of the neighborhood and nearby highlights',
  question: 'A big question mark animates on screen',
  'how it works': 'A step-by-step diagram assembles itself',
  agenda: 'An agenda builds item by item',
  context: 'Background facts laid out on a clean grid',
  insight: 'The key insight highlighted in a bold callout',
  recommendation: 'Recommendations listed with checkmarks',
  twist: 'A sudden zoom punch reveals the twist',
  value: 'The value proposition in giant type',
  story: 'An illustrative frame that sets the story in motion',
  evidence: 'Data and quotes that support the story',
  perspective: 'A new angle on the subject',
  reflection: 'A calm, reflective closing image',
  detail: 'A close look at a telling detail',
  opening: 'The title appears over a bold branded background',
  closing: 'A clean closing frame with the final message',
};

const COMIC_LINES: Readonly<Record<string, readonly [string, ...string[]]>> = {
  setup: ['Just a normal day with {title}.', 'What could possibly go wrong?', 'Okay. Stay calm.'],
  escalation: ['Wait… what?!', 'This is fine. Totally fine.', 'Plan B! Plan B!'],
  punchline: ['Nailed it!', 'Ta-da! …mostly.', 'Worth it.'],
  introduction: ["Hi! Let's talk {title}!", 'Hello, world!'],
  discovery: ["Ooh, what's this?", 'Shiny!'],
  mishap: ['Oops!', 'That was not supposed to happen.'],
  chase: ['Come back here!', 'Faster!'],
  gag: ['Boing!', 'Ta-daaa!'],
  resolution: ['Best. Day. Ever.', 'Happy ending!'],
};

function fill(template: string, title: string): string {
  return template.replace(/\{title\}/g, clip(title, 80));
}

export function beatOpener(beat: string, title: string): string {
  return fill(BEAT_OPENERS[beat] ?? '', title);
}

export function beatVisual(beat: string): string {
  return BEAT_VISUALS[beat] ?? 'A clear, well-composed frame that supports the message';
}

export function comicLine(beat: string, title: string, index: number): string | null {
  const lines = COMIC_LINES[beat];
  if (!lines) return null;
  return fill(lines[index % lines.length] ?? lines[0], title);
}

/** True for the generic beat openers ("Next step.", "Picture this.") so templates can skip them. */
export function isBeatOpener(text: string): boolean {
  const t = text.trim();
  return Object.values(BEAT_OPENERS).some((o) => !o.includes('{title}') && o === t);
}

/**
 * Narration of roughly `targetWords` words for one beat, built from whole sentences
 * (beat opener, lead, then supporting sentences); only an over-long lead is cut at word level.
 */
export function narration(options: {
  beat: string;
  title: string;
  lead: string;
  support: readonly string[];
  targetWords: number;
}): string {
  const target = Math.max(3, Math.round(options.targetWords));
  const ceiling = Math.max(target + 2, Math.round(target * 1.25));
  // The lead may run a little long (narrators speed up); supporting sentences only fill remaining time.
  const leadCeiling = Math.max(ceiling, Math.round(target * 1.6));
  const parts: string[] = [];
  let count = 0;
  const add = (text: string, limit: number): boolean => {
    const s = sentence(text);
    const n = words(s).length;
    if (n === 0) return true;
    if (parts.includes(s)) return true;
    if (count + n > limit) return false;
    parts.push(s);
    count += n;
    return true;
  };
  const opener = beatOpener(options.beat, options.title);
  if (opener && target >= 8) add(opener, ceiling);
  for (const s of sentences(options.lead)) {
    if (!add(s, leadCeiling)) {
      if (parts.length === 0 || count < target * 0.5) {
        const remaining = Math.max(3, target - count);
        parts.push(limitWords(sentence(s), remaining));
        count += remaining;
      }
      break;
    }
  }
  for (const support of options.support) {
    if (count >= target * 0.85) break;
    for (const s of sentences(support)) add(s, ceiling);
  }
  return clip(parts.join(' '), 5000);
}

/** Short on-screen line (≤ `maxWords` words). */
export function shortLine(text: string, maxWords = 8): string {
  return clip(limitWords(text, maxWords).replace(/[.]$/, ''), 120);
}
