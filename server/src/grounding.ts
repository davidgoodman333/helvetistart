// Grounding checks shared by the plan, the chat and fact extraction: does a
// figure the AI wrote actually appear in the official text it was given?

// Every number in the AI's text ("15 hours", "3 months", "CHF 65") must appear
// in what it was given: the step's evidence, plus the student's own answers for
// the personal sentence. Rules never supply numbers, so a number that isn't in
// the sources was made up or remembered from training (e.g. another country's rule).
// A number with a unit ("15 days") must appear with the same unit in the
// source, in English or German ("15 Tage"): a stray "15" elsewhere doesn't
// support a 15-day deadline. Bare numbers only need to appear.
const UNITS: [RegExp, string][] = [
  [/^(hours?|hrs?)$/i, "(hours?|hrs?|stunden?|std)"],
  [/^days?$/i, "(days?|tage?n?)"],
  [/^weeks?$/i, "(weeks?|wochen?)"],
  [/^months?$/i, "(months?|monate?n?)"],
  [/^years?$/i, "(years?|jahre?n?)"],
];

// Sources often spell small numbers out ("innerhalb von drei Monaten").
const NUMBER_WORDS: Record<string, string> = {
  "1": "one|a|an|ein|eine|einem|einen|einer",
  "2": "two|zwei",
  "3": "three|drei",
  "4": "four|vier",
  "5": "five|fünf",
  "6": "six|sechs",
  "7": "seven|sieben",
  "8": "eight|acht",
  "9": "nine|neun",
  "10": "ten|zehn",
  "11": "eleven|elf",
  "12": "twelve|zwölf",
};

export function numbersSupported(text: string, sourceText: string): boolean {
  const mentions = [...text.matchAll(/(\d+)(?:\s*-\s*|\s+)?([a-zA-Z]+)?/g)];
  return mentions.every(([, n, word]) => {
    const unit = word && UNITS.find(([re]) => re.test(word))?.[1];
    if (!unit) return new RegExp(`(^|\\D)${n}(\\D|$)`).test(sourceText);
    const number = NUMBER_WORDS[n] ? `(\\b(${NUMBER_WORDS[n]})\\s+|(^|\\D)${n}[\\s-]*)` : `(^|\\D)${n}[\\s-]*`;
    return new RegExp(`${number}${unit}\\b`, "i").test(sourceText);
  });
}

// --- Quantities ("6 months", "six months", "the first month") --------------
// Used to compare the AI's text with an extracted fact: same unit, different
// number means the text contradicts the fact.

const WORD_VALUES: Record<string, number> = {
  // Not "a"/"an": "15 hours a week" is a rate, not one week.
  one: 1, ein: 1, eine: 1, einem: 1, einen: 1, einer: 1, first: 1, erste: 1, ersten: 1,
  two: 2, zwei: 2, second: 2, zweite: 2, zweiten: 2,
  three: 3, drei: 3, third: 3, dritte: 3, dritten: 3,
  four: 4, vier: 4, fourth: 4, five: 5, fünf: 5, fifth: 5, six: 6, sechs: 6, sixth: 6,
  seven: 7, sieben: 7, eight: 8, acht: 8, nine: 9, neun: 9, ten: 10, zehn: 10,
  eleven: 11, elf: 11, twelve: 12, zwölf: 12,
};

const UNIT_NAMES: [RegExp, string][] = [
  [/^(hours?|hrs?|stunden?|std)$/i, "hour"],
  [/^(days?|tage?n?)$/i, "day"],
  [/^(weeks?|wochen?)$/i, "week"],
  [/^(months?|monate?n?)$/i, "month"],
  [/^(years?|jahre?n?)$/i, "year"],
];

export type Quantity = { n: number; unit: string };

/** Every "number + time unit" in a text, digits or words ("six months", "the first month"). */
export function quantities(text: string): Quantity[] {
  const found: Quantity[] = [];
  const words = Object.keys(WORD_VALUES).join("|");
  const re = new RegExp(`\\b(\\d+|${words})(?:[\\s-]+)([a-zäöü]+)`, "gi");
  for (const [, amount, word] of text.matchAll(re)) {
    const unit = UNIT_NAMES.find(([u]) => u.test(word))?.[1];
    if (!unit) continue;
    const n = /^\d+$/.test(amount) ? Number(amount) : WORD_VALUES[amount.toLowerCase()];
    if (n !== undefined) found.push({ n, unit });
  }
  return found;
}
