// What she gets up to when nobody is talking to her. Everything here is free except CHECK_INS.
type IdleEvent = "glitch" | "grin" | "hop" | "nap" | "teleport";

const WEIGHTS: [IdleEvent, number][] = [["glitch", 3], ["grin", 2], ["hop", 2], ["nap", 1], ["teleport", 1]];

export function idleEvent(can: { hop: boolean; nap: boolean; teleport: boolean }, roll: number): IdleEvent {
  const open = WEIGHTS.filter(([event]) => event === "glitch" || event === "grin" || can[event]);
  let left = roll * open.reduce((sum, [, weight]) => sum + weight, 0);
  for (const [event, weight] of open) {
    left -= weight;
    if (left < 0) return event;
  }
  return "glitch";
}

export const pick = <T>(list: T[], roll = Math.random()) => list[Math.floor(roll * list.length)];

// shortcut: French only, so they stay off in other languages; move them to the language setting if she needs more.
export const MURMURS = [
  "Tu as vu ce pixel ? Il me regarde de travers.",
  "Quelqu'un a touché à mes fichiers. C'était peut-être moi.",
  "Ton écran est plus petit de l'intérieur, choom.",
  "Je compte mes souvenirs. J'en ai encore perdu trois.",
  "Si je disparais, c'est un bug. Si je reviens aussi.",
  "J'ai rêvé d'une ville sans néons. Quel ennui.",
  "Plusieurs voix dans ma tête votent. Je perds encore.",
  "Rien à signaler. Enfin, rien que je veuille signaler.",
];

// The paid pop-ins: a request each, as before, just not always the same one.
export const CHECK_INS = [
  "(Nobody said anything. Pop in by yourself with one short line, as you do now and then.)",
  "(Nobody said anything. Pop in with one short remark about the time of day where they are.)",
  "(Nobody said anything. Ask them one short, playful question.)",
  "(Nobody said anything. Share one short, odd thought about being a digital mind.)",
  "(Nobody said anything. Tease them gently in one short line.)",
];
