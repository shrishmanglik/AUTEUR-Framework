import {
  DevelopmentRequestSchema,
  UniversalPacketSchema,
  type ContentFormat,
  type DevelopmentRequest,
  type UniversalPacket,
} from "./schemas.js";
import { selectFramework } from "./development.js";

/**
 * The deterministic bridge.
 *
 * Every other projection in this toolkit starts from a Universal Packet. Producing that
 * first packet from a raw idea was the one step the toolkit did not do, so the documented
 * path ran: develop -> (your own LLM) -> validate -> kit. That step is a real dependency,
 * not a missing feature - but it is not the ONLY way to reach a packet.
 *
 * draftPacket closes the same gap with a rule system instead of a model: a seeded creative
 * lens picks the angle, a per-format narrative arc lays out the beats, and a shot grammar
 * turns each beat into a fully specified shot. Same request in, byte-identical packet out,
 * no network, no credentials, no spend.
 *
 * It does not replace the LLM path and does not pretend to. A model writes better prose and
 * finds stranger premises. This exists so the pipeline has a floor: something runnable and
 * inspectable before any provider is involved, and a fixture generator for the frameworks
 * that had selection tests but no end-to-end packet.
 */

// ---------- seeded randomness ----------
// FNV-1a over the seed text, then xorshift32. Deterministic and dependency-free: the same
// seed text always yields the same sequence, which is what makes drafts reproducible.
function hashText(text: string): number {
  let value = 2166136261;
  for (const character of String(text)) {
    value ^= character.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

function makeRng(seedText: string): () => number {
  let state = hashText(seedText) || 88675123;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5; state >>>= 0;
    return state / 4294967296;
  };
}

const pick = <T>(rng: () => number, list: readonly T[]): T => (
  list[Math.floor(rng() * list.length) % list.length]!
);

const pickN = <T>(rng: () => number, list: readonly T[], count: number): T[] => {
  const pool = [...list];
  const out: T[] = [];
  while (pool.length && out.length < count) {
    out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]!);
  }
  return out;
};

// ---------- idea parsing ----------
const STOPWORDS = new Set((
  "a,an,the,and,or,but,of,for,to,in,on,at,with,about,from,into,over,after,before,under,is,are,"
  + "was,were,be,being,been,it,its,this,that,these,those,i,we,you,they,he,she,my,our,your,their,"
  + "make,making,want,need,video,film,ad,commercial,reel,short,story,scene,shot,who,whom,whose,"
  + "now,one,last,first,can,could,should,would,will,just,very,really,when,where,then,than,there,"
  + "here,what,which,how,why,his,her,him,hers,them,through,while,against,between,because,so,too,"
  + "also,only,ever,never,once,by,as,up,down,out,off,not,no,yes,do,does,did,has,have,had,get,"
  + "gets,got,go,goes,went,second,seconds,minute,minutes,vertical,horizontal,direct,camera,"
  + "called,format,create,cinematic,"
  // Prepositions, adverbs and quantifiers the list above lacked. "throughout" is not what a
  // film is about, but as the longest word in "keeping its base fixed throughout" it became
  // the anchor of a published example.
  + "throughout,beside,besides,until,onto,upon,within,without,across,around,along,among,amid,"
  + "beyond,behind,beneath,below,above,toward,towards,during,despite,underneath,inside,outside,"
  + "again,even,always,already,almost,away,together,instead,ago,yet,twice,every,each,some,any,"
  + "all,both,either,neither,such,other,another,same,own,more,most,less,least,many,much,few,"
  + "nobody,somebody,anybody,everybody,someone,anyone,everyone,nothing,something,anything,"
  + "everything,"
  // Framing words state the production's status, not what is in frame: "a fictional
  // librarian" is about the librarian. Scored on length, "fictional" anchored three examples.
  + "fictional,fictitious,imaginary,hypothetical,synthetic,invented"
).split(","));

// A trailing -s marks a plural or a third-person verb; "glass", "status" and "axis" are neither.
const endsInVerbS = (word: string): boolean => /s$/.test(word) && !/(?:ss|us|is)$/.test(word);

// Irregular past forms carry no -ed, so the suffix filter reads them as nouns: "a process
// nobody on the team actually understood" anchored on "understood". Forms that are also
// common production nouns (set, cut, felt, rose, saw, run) are deliberately left out.
const IRREGULAR_PAST = new Set((
  "understood,withstood,stood,built,made,done,gone,known,shown,thrown,grown,drawn,flown,"
  + "blown,held,told,sold,found,kept,lost,meant,met,paid,said,sent,spent,taught,thought,"
  + "brought,bought,caught,fought,sought,won,begun,sung,swum,struck,stuck,hung,dug,spun,"
  + "fled,sped,slid,hid,woke,broke,chose,froze,stole,swore,drove,wrote,rode,gave,came,"
  + "became,took,shook,forgot,heard,laid,slept,wept,crept,swept,knelt,dealt,leapt"
).split(","));

const FORMAT_NOISE = /\b(?:\d+(?:\.\d+)?\s*(?:s|sec|secs|second|seconds|min|mins|minute|minutes)|short\s+film|music\s+video|a-?roll|vertical\s+reel|reel|trailer|teaser|video|film|commercial|scene|shot)\b/gi;

interface ParsedIdea {
  clean: string;
  subject: string;
  anchor: string;
  world: string;
  keywords: string[];
}

const titleCase = (value: string): string => (
  String(value).replace(/\b\w/g, (character) => character.toUpperCase())
);

function namedSubject(clean: string): string {
  const called = clean.match(/\b(?:called|named)\s+["']?([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*){0,4})["']?/);
  if (called?.[1]) return called[1].replace(/[.,;:!?]+$/, "");
  const quoted = clean.match(/["']([^"']{2,60})["']/);
  return quoted?.[1] ?? "";
}

export function parseIdea(idea: string): ParsedIdea {
  const clean = String(idea ?? "").replace(/\s+/g, " ").trim();
  const semantic = clean.replace(FORMAT_NOISE, " ").replace(/\s+/g, " ").trim();
  // Punctuation is kept as a token of its own so a noun phrase never runs across a comma.
  const tokens = semantic.match(/[a-zA-Z0-9'-]+|[^a-zA-Z0-9'\s-]/g) ?? [];
  const isContent = (token: string): boolean => (
    /^[a-zA-Z0-9'-]+$/.test(token) && token.length > 2 && !STOPWORDS.has(token.toLowerCase())
  );
  const content = tokens.filter(isContent);
  const explicitName = namedSubject(clean);

  // Score on the longest hyphen-free part: "night-shift" and "hand-blown" are long strings
  // but adjectival, and scoring them whole let them beat concrete nouns like "controller".
  const specificity = (word: string): number => Math.max(
    ...word.split("-").map((part) => part.length),
  );
  // Verb and participle forms are long without being the thing the film is about, and
  // length alone cannot see that. This is a crude morphological filter, not a
  // part-of-speech tagger: it demotes "discovers", "poured" and "unbroken" so the concrete
  // noun beside them wins.
  const looksInflected = (word: string): boolean => (
    /(?:ing|ed|en|ly)$/.test(word) || endsInVerbS(word) || IRREGULAR_PAST.has(word.toLowerCase())
  );

  // Candidates are the heads of noun phrases. English noun phrases end on their noun, so in
  // a run of adjacent content words the earlier ones are modifiers: "fictional bell maker",
  // "bronze bell", "clay seal", "air traffic controller". Scoring every word on length, as
  // the first version did, let a long modifier or adverb win: "fictional" beat "librarian"
  // and "throughout" beat "sapling". A run ends at a stopword, at punctuation, and after an
  // -s form followed by another content word, which is a verb ("taps", "becomes") rather
  // than a modifier. Participles stay inside the run ("low padded barrier") but cannot be
  // its head.
  const phrases: string[][] = [];
  let run: string[] = [];
  for (const token of tokens) {
    if (!isContent(token)) {
      if (run.length) phrases.push(run);
      run = [];
      continue;
    }
    const previous = run.at(-1);
    if (previous && endsInVerbS(previous)) {
      phrases.push(run);
      run = [];
    }
    run.push(token);
  }
  if (run.length) phrases.push(run);

  const heads = phrases.flatMap((words) => {
    // An -ing word directly before a finite -s verb is that verb's subject, so a noun:
    // "a paper sapling unfolds", "the ceiling drips". Read as a participle, "sapling" lost
    // to its own modifier and the tree example was titled "Paper".
    const canHead = (index: number): boolean => {
      const word = words[index]!;
      const next = words[index + 1];
      return !looksInflected(word) || (/ing$/.test(word) && next !== undefined && endsInVerbS(next));
    };
    let headIndex = words.length - 1;
    while (headIndex >= 0 && !canHead(headIndex)) headIndex -= 1;
    if (headIndex < 0) return [];
    const head = words[headIndex]!;
    // The subject reads as the noun phrase itself, without a participle, capped at three
    // words so "junior air traffic controller" titles as "Air Traffic Controller".
    const phrase = words.slice(0, headIndex + 1)
      .filter((word) => word === head || !looksInflected(word))
      .slice(-3)
      .join(" ");
    return [{ head, phrase }];
  });

  // A head the idea names more than once is what it is about ("a bell maker taps a bronze
  // bell"); only then does length stand in for specificity. Ties go to the earliest head so
  // the result stays stable. A sentence with no noun-like head still yields an anchor from
  // its content words.
  const mentions = (word: string): number => (
    content.filter((other) => other.toLowerCase() === word.toLowerCase()).length
  );
  const best = heads.reduce<(typeof heads)[number] | undefined>((leader, candidate) => {
    if (!leader) return candidate;
    const lead = mentions(candidate.head) - mentions(leader.head);
    return lead > 0 || (lead === 0 && specificity(candidate.head) > specificity(leader.head))
      ? candidate
      : leader;
  }, undefined);
  let fallback = content[0] ?? "";
  for (const word of content) {
    if (specificity(word) > specificity(fallback)) fallback = word;
  }
  const anchor = explicitName
    ? explicitName.split(/\s+/)[0]!
    : best?.head || fallback || "subject";
  const phrase = best?.phrase ?? fallback;
  const subject = explicitName
    || phrase
    || content.slice(0, 3).join(" ")
    || semantic.split(" ").slice(0, 3).join(" ")
    || "the subject";

  // "in/at/on" introduces a place about as often as it introduces a temporal clause, and the
  // capture runs to the next comma either way. On "On her last night shift before the tower is
  // automated, ..." the old version produced the world "her last night shift before the", which
  // reached the kit as the scene location "her last night shift before the interior, controlled
  // light". Broken English in a generated document is worse than a plainer correct phrase.
  const rawLocation = clean.match(/\b(?:in|inside|at|on)\s+(?:an?\s+|the\s+)?([^.,;]{3,80})/i)?.[1];
  const clauseLike = rawLocation
    ? /^(?:her|his|their|my|our|your|its)\b/i.test(rawLocation.trim())
      || /\b(?:is|are|was|were|has|have|will|keeps?|before|after|while)\b/i.test(rawLocation)
    : true;
  const trimmed = rawLocation && !clauseLike
    ? rawLocation.split(/\s+/).slice(0, 6).join(" ")
      // A word cap can end on a function word and leave a dangling phrase.
      .replace(/\s+(?:the|a|an|of|in|on|at|to|for|and|or|before|after|is|are|was|were)$/i, "")
    : "";
  // Falling back to the subject reads plainly. It is not a place, and the drafter does not
  // pretend it is: no downstream text asserts that the world was extracted from the idea.
  const world = trimmed || subject || "its world";
  return {
    clean: clean || "an untitled idea",
    subject: titleCase(subject),
    anchor,
    world: world || "its world",
    keywords: content.slice(0, 14),
  };
}

// ---------- creative lenses ----------
export interface DraftConcept {
  id: string;
  lens: string;
  name: string;
  logline: string;
  twist: string;
  thesis: string;
  tone: string;
  mood: string;
}

interface Lens {
  key: string;
  name: string;
  pitch: (idea: ParsedIdea) => string;
  twist: (idea: ParsedIdea) => string;
  thesis: string;
  tone: string;
  mood: string;
}

const LENSES: readonly Lens[] = [
  {
    key: "literal-metaphor",
    name: "The Literal Metaphor",
    pitch: (idea) => `Take the promise of ${idea.subject} literally and build a physical world where it is simply true.`,
    twist: (idea) => `The metaphor is never explained; the world just obeys it, and ${idea.anchor} is the only thing behaving normally.`,
    thesis: "Meaning lands harder when the image does the arguing and nobody in frame acknowledges the miracle.",
    tone: "Hyper-real with one impossible rule",
    mood: "Confident wonder",
  },
  {
    key: "pov-flip",
    name: "The POV Flip",
    pitch: (idea) => `Tell ${idea.subject} from the least expected witness: the object, the obstacle, or the rival watching it happen.`,
    twist: () => "We only reach the human story in the final shot, recontextualizing everything the witness misread.",
    thesis: "A familiar promise becomes new when the camera is loyal to the wrong character.",
    tone: "Intimate, observational, slightly conspiratorial",
    mood: "Playful tension",
  },
  {
    key: "escalation-engine",
    name: "The Escalation Engine",
    pitch: (idea) => `One small action involving ${idea.anchor} compounds shot over shot until the scale turns absurd, then lands exactly where the brief needs it.`,
    twist: (idea) => `The final beat reveals the escalation was contained inside one ordinary moment of ${idea.world}.`,
    thesis: "Momentum is the argument; discipline is the payoff.",
    tone: "Kinetic, rhythmic, precisely choreographed",
    mood: "Barely contained mischief",
  },
  {
    key: "contrast-cut",
    name: "The Contrast Cut",
    pitch: (idea) => `Two opposing worlds, one starved of ${idea.anchor} and one saturated with it, intercut until they collide in a single frame.`,
    twist: () => "The collision shot reveals the two worlds were the same place, seconds apart.",
    thesis: "Difference is the fastest proof; the cut is the argument.",
    tone: "Graphic, symmetrical, colour-coded worlds",
    mood: "Cool authority",
  },
  {
    key: "one-take-dare",
    name: "The One-Take Dare",
    pitch: (idea) => `${idea.subject} staged as one continuous, impossibly choreographed take where the camera never blinks.`,
    twist: () => "Everything the take passes changes state behind the camera's back, visible only on the return pass.",
    thesis: "Unbroken time creates trust, and trust makes the payoff land as fact.",
    tone: "Flowing steadicam realism with staged precision",
    mood: "Held-breath momentum",
  },
  {
    key: "deadpan-documentary",
    name: "The Deadpan Documentary",
    pitch: (idea) => `A gravely serious documentary crew treats ${idea.subject} as the most consequential event of the decade.`,
    twist: () => "The experts are sincere, credentialed, and entirely correct; the world around them is what is absurd.",
    thesis: "Scale the reverence up and the smallness of the subject becomes the charm.",
    tone: "Documentary naturalism, tripod discipline",
    mood: "Solemn absurdity",
  },
  {
    key: "time-fracture",
    name: "The Time Fracture",
    pitch: (idea) => `Open on the final second of ${idea.subject}, then earn it, assembling the timeline out of order until the opening image means the opposite.`,
    twist: (idea) => `A single continuity detail, ${idea.anchor}, re-sorts every scene on a second viewing.`,
    thesis: "Structure is suspense; the audience assembles the story and owns it.",
    tone: "Precise, chaptered, clock-like",
    mood: "Inevitable revelation",
  },
  {
    key: "loaded-table",
    name: "The Loaded Table",
    pitch: (idea) => `Two people at a mundane surface talk about everything except ${idea.subject} while it sits between them, loaded.`,
    twist: () => "The conversation was the demonstration all along, and the final line detonates the subtext.",
    thesis: "Tension lives in the unsaid; the object is the third character.",
    tone: "Locked frames, patient coverage, loaded props",
    mood: "Simmering charm",
  },
];

export const DRAFT_LENS_COUNT = LENSES.length;

/** Three distinct concepts for one request. Stable per (idea, format, seed). */
export function ideateConcepts(input: unknown, seed = 0): DraftConcept[] {
  const request = DevelopmentRequestSchema.parse(input);
  const idea = parseIdea(request.idea);
  const rng = makeRng(`${idea.clean}::${request.format}::${seed}`);
  return pickN(rng, LENSES, 3).map((lens, index) => ({
    id: `concept-${lens.key}-${seed}-${index}`,
    lens: lens.key,
    name: lens.name,
    logline: lens.pitch(idea),
    twist: lens.twist(idea),
    thesis: lens.thesis,
    tone: lens.tone,
    mood: lens.mood,
  }));
}

// ---------- shot grammar ----------
interface ShotSpec {
  size: string;
  movement: string;
  framing: string;
  focusBehavior: string;
  lensModel: string;
  focalLengthMm: number;
  tStop: number;
  subjectDistanceMeters: number;
}

const GRAMMAR: Record<string, ShotSpec> = {
  wide: {
    size: "wide establishing", movement: "locked tripod with a slow settle",
    framing: "subject on the lower third with the world readable above",
    focusBehavior: "deep focus holds both subject and environment legible",
    lensModel: "spherical prime", focalLengthMm: 24, tStop: 5.6, subjectDistanceMeters: 6,
  },
  medium: {
    size: "medium shot", movement: "slow measured push",
    framing: "subject centred with working space camera-left",
    focusBehavior: "focus holds the subject with the background softly separated",
    lensModel: "spherical prime", focalLengthMm: 40, tStop: 2.8, subjectDistanceMeters: 2.5,
  },
  close: {
    size: "close-up", movement: "handheld held nearly still",
    framing: "eyes on the upper third",
    focusBehavior: "focus locked on the near eye",
    lensModel: "spherical prime", focalLengthMm: 85, tStop: 2, subjectDistanceMeters: 1.2,
  },
  macro: {
    size: "extreme macro detail", movement: "micro parallax across the surface",
    framing: "the detail fills the lower centre of frame",
    focusBehavior: "focus settles from the leading edge to the material grain",
    lensModel: "macro prime", focalLengthMm: 100, tStop: 4, subjectDistanceMeters: 0.5,
  },
  hero: {
    size: "hero frame", movement: "slow release and hold",
    framing: "subject composed dead centre with symmetrical margin",
    focusBehavior: "focus rests on the subject and does not travel",
    lensModel: "spherical prime", focalLengthMm: 50, tStop: 2.8, subjectDistanceMeters: 1.8,
  },
  two: {
    size: "two-shot", movement: "locked tripod",
    framing: "both figures held across the frame with the object between them",
    focusBehavior: "split focus keeps both faces and the object readable",
    lensModel: "spherical prime", focalLengthMm: 35, tStop: 2.8, subjectDistanceMeters: 3,
  },
  insert: {
    size: "insert detail", movement: "snap to a locked insert",
    framing: "the object occupies the centre with clean negative space",
    focusBehavior: "focus lands on the object and holds",
    lensModel: "macro prime", focalLengthMm: 100, tStop: 4, subjectDistanceMeters: 0.6,
  },
  track: {
    size: "tracking medium", movement: "tracking follow at walking pace",
    framing: "subject held at a constant screen position while the world moves",
    focusBehavior: "focus tracks the subject through the move",
    lensModel: "spherical prime", focalLengthMm: 35, tStop: 2.8, subjectDistanceMeters: 2.2,
  },
};

interface ArcBeat {
  name: string;
  share: number;
  intent: string;
  sizes: string[];
}

// One narrative arc per public content format. Shares are relative, not absolute seconds,
// so the same arc serves a six-second reel and a ninety-second short film.
const ARCS: Record<string, ArcBeat[]> = {
  advertising: [
    { name: "Hook", share: 0.18, intent: "Interrupt with the strangest true image of the idea", sizes: ["wide", "insert"] },
    { name: "Friction", share: 0.2, intent: "Show the world straining without the promise", sizes: ["medium"] },
    { name: "The Turn", share: 0.24, intent: "The subject enters and the rule of the world changes", sizes: ["track", "close"] },
    { name: "Proof", share: 0.22, intent: "Hero behaviour rendered as physical fact, close enough to touch", sizes: ["macro"] },
    { name: "Button", share: 0.16, intent: "One held image that owns the promise, with any title reserved for post", sizes: ["hero"] },
  ],
  narrative: [
    { name: "Cold open", share: 0.15, intent: "Start inside a moment already in motion", sizes: ["close"] },
    { name: "Setup", share: 0.2, intent: "Establish the character, the want, and the loaded object", sizes: ["wide", "two"] },
    { name: "Escalation", share: 0.25, intent: "Complication compounds and the want gets expensive", sizes: ["medium", "insert"] },
    { name: "Climax", share: 0.25, intent: "The decisive action lands with real physical consequence", sizes: ["track", "close"] },
    { name: "Resolution", share: 0.15, intent: "What changed, said with one image", sizes: ["hero"] },
  ],
  social: [
    { name: "Pattern interrupt", share: 0.22, intent: "The first frame earns attention inside one second", sizes: ["close"] },
    { name: "Promise", share: 0.2, intent: "State the payoff visually before explaining anything", sizes: ["medium"] },
    { name: "Payoff run", share: 0.38, intent: "Deliver the satisfying run of the idea, rhythmically", sizes: ["macro", "track"] },
    { name: "Button", share: 0.2, intent: "A final beat that rewinds cleanly into the hook", sizes: ["hero"] },
  ],
  monologue: [
    { name: "Hook", share: 0.2, intent: "The single most contrarian line, straight to lens", sizes: ["close"] },
    { name: "The argument", share: 0.5, intent: "Concrete beats, each with one bounded physical gesture", sizes: ["medium"] },
    { name: "Call", share: 0.3, intent: "One imperative, then silence held to the cut", sizes: ["medium"] },
  ],
  performance: [
    { name: "Motif", share: 0.2, intent: "Establish the repeating visual figure", sizes: ["wide"] },
    { name: "Verse world", share: 0.25, intent: "Performance inside the first world", sizes: ["medium", "close"] },
    { name: "Chorus lift", share: 0.25, intent: "The motif transforms and the scale jumps", sizes: ["wide", "track"] },
    { name: "Bridge fracture", share: 0.15, intent: "Break the pattern once, hard", sizes: ["macro"] },
    { name: "Final chorus", share: 0.15, intent: "The motif at full scale, held to blackout", sizes: ["hero"] },
  ],
  chamber: [
    { name: "The scene", share: 1, intent: "One continuous dramatic unit: enter late, turn once, leave early", sizes: ["two", "close", "insert"] },
  ],
  frames: [
    { name: "Hero frame", share: 1, intent: "The defining image with the subject at full authority", sizes: ["hero"] },
    { name: "Detail study", share: 1, intent: "The material truth of the subject, close enough to touch", sizes: ["macro"] },
    { name: "World context", share: 1, intent: "The subject placed inside the world whose rule it bends", sizes: ["wide"] },
  ],
};

const FORMAT_ARC: Record<ContentFormat, keyof typeof ARCS> = {
  "short-film": "narrative",
  ad: "advertising",
  reel: "social",
  "a-roll": "monologue",
  "b-roll": "advertising",
  "music-video": "performance",
  "product-film": "advertising",
  "character-scene": "chamber",
  vfx: "advertising",
  animation: "advertising",
  image: "frames",
  sequence: "narrative",
  other: "advertising",
};

// Read against beat position, so a five-beat arc does not stamp one sentence five times.
const BEAT_TURNS: ReadonlyArray<(mood: string) => string> = [
  (mood) => `the ${mood} is established before anything is explained`,
  (mood) => `the ${mood} tightens as the want becomes specific`,
  (mood) => `the ${mood} turns costly and the easy option closes`,
  (mood) => `the ${mood} breaks into a decision that cannot be taken back`,
  (mood) => `the ${mood} settles into what the decision left behind`,
];

const CAST_NAMES = ["MARA", "DEV", "JUNE", "OKAFOR", "LENA", "SAUL", "PRIYA", "COLE"];

/**
 * The part of a transformation brief the request itself says must not move: "fixed paper
 * base" in mustInclude, or "keeping its base fixed" in the idea. mustInclude is read first
 * because it names the part more fully. Returns "" when nothing is declared fixed; the
 * drafter does not guess one.
 */
function declaredFixedPart(request: DevelopmentRequest): string {
  for (const text of [...request.mustInclude, request.idea]) {
    const kept = text.match(
      /\bkeep(?:s|ing)?\s+(?:its|the|their|his|her|a|an)\s+([a-z][\w-]*(?:\s+[a-z][\w-]*)?)\s+(?:fixed|still|stationary|unchanged|in place)\b/i,
    )?.[1];
    if (kept) return kept.toLowerCase();
    const after = text.match(/\b(?:fixed|stationary|unmoving)\s+([^.,;:!?]+)/i)?.[1] ?? "";
    // Only the noun phrase straight after the adjective: "fixed throughout" names no part.
    const words: string[] = [];
    for (const word of after.split(/\s+/)) {
      if (!/^[a-zA-Z][\w-]*$/.test(word) || STOPWORDS.has(word.toLowerCase()) || words.length === 3) break;
      words.push(word.toLowerCase());
    }
    if (words.length) return words.join(" ");
  }
  return "";
}

// ---------- drafting ----------
export interface DraftOptions {
  /** Changes the concept selection and every downstream choice. Same seed, same packet. */
  seed?: number;
  /** Which of the three concepts to build. Defaults to the first. */
  conceptIndex?: number;
}

export interface DraftResult {
  packet: UniversalPacket;
  concept: DraftConcept;
  alternatives: DraftConcept[];
  seed: number;
  deterministic: true;
}

/**
 * Splits a duration into whole-second beats that sum to exactly the duration. Preflight
 * treats a temporal plan that does not fill the shot as an error, so this must be exact
 * rather than approximately right.
 */
function tileBeats(durationSeconds: number, count: number): Array<{ start: number; end: number }> {
  const slots = Math.max(1, Math.min(count, Math.floor(durationSeconds)));
  const base = Math.floor(durationSeconds / slots);
  let remainder = durationSeconds - base * slots;
  const out: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (let index = 0; index < slots; index += 1) {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    const end = cursor + base + extra;
    out.push({ start: cursor, end });
    cursor = end;
  }
  return out;
}

/** Distributes a total duration across beats by share, in whole seconds, summing exactly. */
function allocateDurations(total: number, shares: number[]): number[] {
  const shareSum = shares.reduce((sum, share) => sum + share, 0) || 1;
  const raw = shares.map((share) => (total * share) / shareSum);
  const floored = raw.map((value) => Math.max(2, Math.floor(value)));
  let drift = total - floored.reduce((sum, value) => sum + value, 0);
  // Hand any rounding remainder to the largest beats first, and claw a deficit back from
  // the largest beats that can still spare a second without dropping under two.
  const order = raw
    .map((value, index) => ({ index, value }))
    .sort((left, right) => right.value - left.value)
    .map((entry) => entry.index);
  let guard = 0;
  while (drift !== 0 && guard < 10000) {
    for (const index of order) {
      if (drift === 0) break;
      if (drift > 0) { floored[index]! += 1; drift -= 1; }
      else if (floored[index]! > 2) { floored[index]! -= 1; drift += 1; }
    }
    guard += 1;
  }
  return floored;
}

export function draftPacket(input: unknown, options: DraftOptions = {}): DraftResult {
  const request: DevelopmentRequest = DevelopmentRequestSchema.parse(input);
  const seed = options.seed ?? 0;
  const concepts = ideateConcepts(request, seed);
  const conceptIndex = Math.min(Math.max(options.conceptIndex ?? 0, 0), concepts.length - 1);
  const concept = concepts[conceptIndex]!;

  const idea = parseIdea(request.idea);
  const rng = makeRng(`${idea.clean}::${concept.lens}::${seed}`);
  const framework = selectFramework(request);
  const isARoll = request.format === "a-roll";
  const isFrames = request.format === "image";
  // A transformation brief changes its anchor by definition. Locking the anchor's geometry
  // forbade the brief itself: the temporal-evolution compiler printed "sapling geometry and
  // finish unchanged" as an immutable key of a sapling that must unfold into a tree. Such a
  // brief locks only the part the request declares fixed, and nothing when it declares none.
  const fixedPart = request.requiresTransformation ? declaredFixedPart(request) : "";
  const objectLocks = request.requiresTransformation
    ? (fixedPart ? [`${fixedPart} position, geometry and finish unchanged`] : [])
    : [`${idea.anchor} geometry and finish unchanged`];

  const arc = ARCS[FORMAT_ARC[request.format]]!;
  const total = Math.max(arc.length * 2, Math.round(request.targetDurationSeconds));

  // Keep the highest-share beats when the target is too short to give every beat two seconds.
  const maxBeats = Math.max(1, Math.floor(total / 2));
  const kept = arc.length > maxBeats
    ? arc.filter((beat) => new Set([...arc].sort((l, r) => r.share - l.share).slice(0, maxBeats)).has(beat))
    : arc;

  const durations = allocateDurations(total, kept.map((beat) => beat.share));

  const castSize = isARoll ? 1 : FORMAT_ARC[request.format] === "chamber" ? 2 : 1;
  const cast = pickN(rng, CAST_NAMES, castSize);
  const characters = cast.map((name, index) => ({
    id: name.toLowerCase(),
    name: titleCase(name.toLowerCase()),
    // Deliberately not `principal in ${world}`: world is a best-effort extraction, and
    // splicing it here turned one bad parse into a bad character role as well.
    role: index === 0 ? "principal" : "counterpart",
    identityLock: [
      pick(rng, ["a person in their early thirties", "a person in their forties", "a person in their late twenties"]),
      pick(rng, ["dark hair pinned flat", "close-cropped grey hair", "shoulder-length hair tied back"]),
      pick(rng, ["a small scar on the right thumb", "reading glasses pushed up", "a worn signet ring"]),
    ],
    wardrobeLock: [
      pick(rng, ["a charcoal work shirt with rolled sleeves", "a navy jacket over a plain tee", "a faded denim overshirt"]),
      pick(rng, ["scuffed leather boots", "worn canvas shoes", "plain dark trousers"]),
    ],
  }));

  const palette = pickN(rng, [
    "cool tungsten", "aged concrete", "muted navy", "sodium orange", "bone white",
    "deep charcoal", "oxidised green", "dust grey",
  ], 3);
  const primarySource = pick(rng, [
    "a single motivated practical lamp",
    "one large north-facing window",
    "overhead industrial fluorescents",
    "a low raking work light",
  ]);

  // Built as schema INPUT, not parsed output: defaults such as camera.capture are filled by
  // UniversalPacketSchema.parse at the end, which is also what validates the whole draft.
  const scenes: Array<Record<string, unknown>> = [];
  const shots: Array<Record<string, unknown> & { durationSeconds: number }> = [];

  kept.forEach((beat, beatIndex) => {
    const sceneId = `scene-${beatIndex + 1}`;
    const durationSeconds = durations[beatIndex]!;
    const sizeKey = beat.sizes[beatIndex % beat.sizes.length]!;
    const spec = GRAMMAR[sizeKey] ?? GRAMMAR.medium!;
    const shotId = `shot-${beatIndex + 1}`;
    const isFinal = beatIndex === kept.length - 1;

    scenes.push({
      id: sceneId,
      title: beat.name,
      purpose: beat.intent,
      location: `${idea.world} interior, controlled light`,
      timeOfDay: pick(rng, ["dawn", "mid-morning", "late afternoon", "after dark"]),
      shotIds: [shotId],
    });

    const tiles = tileBeats(durationSeconds, 3);
    const actionLine = `${beat.intent.toLowerCase()}, staged so the change is visible in frame`;

    // A-roll carries exact speech, so it gets a spoken window sized to the line. Everything
    // else keeps dialogue out of the draft: an invented line is a creative claim, and the
    // toolkit should not put words in a production's mouth by default.
    const spokenLine = isARoll && request.hasDialogue !== false
      ? `${concept.thesis}`
      : undefined;
    const speechSeconds = Math.min(durationSeconds - 0.5, Math.max(1, durationSeconds * 0.7));

    shots.push({
      id: shotId,
      sceneId,
      title: beat.name,
      characterIds: characters.map((character) => character.id),
      generationRisks: [
        ...(characters.length ? ["IDENTITY_OR_PERFORMANCE" as const] : []),
        ...(spokenLine ? ["EXACT_DIALOGUE_AUDIO" as const] : []),
      ],
      durationSeconds,
      intent: beat.intent,
      subject: `${characters[0]?.name ?? idea.subject} with ${idea.anchor} in frame`,
      action: actionLine,
      environment: `${idea.world}, dressed plainly so ${idea.anchor} reads first`,
      camera: {
        shotType: spec.size,
        movement: spec.movement,
        framing: spec.framing,
        focusBehavior: spec.focusBehavior,
        optics: {
          cameraBody: "full-frame cinema camera",
          lensModel: spec.lensModel,
          focalLengthMm: spec.focalLengthMm,
          tStop: spec.tStop,
          subjectDistanceMeters: spec.subjectDistanceMeters,
        },
      },
      lighting: {
        primarySource,
        motivation: `the only powered source in ${idea.world}`,
        paletteBase: palette,
        isDesaturated: true,
        isCrushedBlacks: false,
      },
      physics: [
        `${idea.anchor} holds its mass and does not drift between beats`,
        "contact between hand and object deforms both believably",
        "any settling motion decays under gravity rather than stopping abruptly",
      ],
      materials: pickN(rng, [
        "brushed steel", "scarred walnut", "worn cotton", "aged paper",
        "painted concrete", "matte ceramic", "oxidised brass",
      ], 3),
      beats: tiles.map((tile, tileIndex) => ({
        startSeconds: tile.start,
        endSeconds: tile.end,
        action: tileIndex === 0
          ? `the frame settles and ${idea.anchor} is established in its opening state`
          : tileIndex === tiles.length - 1
            ? (isFinal
              ? "the final state holds, composed, until the cut"
              : "the beat resolves into a stable handoff")
            : actionLine,
      })),
      continuityLocks: [
        ...characters.map((character) => `${character.name} identity and wardrobe unchanged`),
        ...objectLocks,
        "light direction and screen direction unchanged",
      ],
      imperfectionAnchors: pickN(rng, [
        "a faint fingerprint on the nearest surface",
        "one edge worn lighter than the rest",
        "dust settled along a single seam",
        "a hairline scratch catching the key light",
        "an uneven patina where the object is handled most",
      ], 3),
      ...(isARoll
        ? { performance: { mode: "restrained-stillness" as const } }
        : {}),
      audioTrack: {
        soundDesignDirectives: pickN(rng, [
          "close handling contact on the hero object",
          "low room tone with no music bed",
          "one distant environmental layer",
          "fabric movement bound to visible motion",
        ], 3),
        musicDirective: "no score",
        ...(spokenLine
          ? {
            spokenText: spokenLine,
            spokenWindow: { startSeconds: 0.25, endSeconds: Math.round((0.25 + speechSeconds) * 100) / 100 },
          }
          : {}),
      },
      ...(spokenLine ? { dialogue: spokenLine } : {}),
      exclusions: [
        "no invented signage, logos, or on-screen text",
        "no identity drift between beats",
        `no ${isFrames ? "motion blur implying movement" : "unmotivated camera move"}`,
      ],
      frameworkId: framework.id,
    });
  });

  const packet = UniversalPacketSchema.parse({
    schemaVersion: "1.0.0",
    metadata: {
      title: `${idea.subject}: ${concept.name}`,
      format: request.format,
      aspectRatio: request.aspectRatio,
      targetDurationSeconds: shots.reduce((sum, shot) => sum + shot.durationSeconds, 0),
      audience: request.audience,
      tone: request.tone,
      providerTarget: "provider-neutral",
      continuityStrictness: "strict",
      audioRequired: request.audioRequired ?? true,
    },
    story: {
      logline: concept.logline,
      // Built from the subject and the chosen lens only. An earlier version spliced in the
      // parsed location, which is a sentence fragment and read as broken English. A
      // deterministic drafter cannot invent an authored dramatic question from an arbitrary
      // sentence, so this states the structural question plainly instead of faking one.
      dramaticQuestion: `Does ${idea.subject} still hold once the rule of the world changes?`,
      beats: kept.map((beat, index) => ({
        id: `beat-${index + 1}`,
        title: beat.name,
        purpose: beat.intent,
        // Varying by position rather than repeating one line on every beat. An arc that
        // states the identical turn five times is visibly generated, and says nothing.
        emotionalTurn: BEAT_TURNS[Math.min(index, BEAT_TURNS.length - 1)]!(concept.mood.toLowerCase()),
      })),
    },
    characters,
    scenes,
    shots,
    globalStyle: [concept.tone.toLowerCase(), concept.mood.toLowerCase(), "physically credible materials"],
    globalExclusions: [
      "no identity drift",
      "no generated signage",
      "no unmotivated lens flare",
    ],
  });

  return {
    packet,
    concept,
    alternatives: concepts.filter((_, index) => index !== conceptIndex),
    seed,
    deterministic: true,
  };
}
