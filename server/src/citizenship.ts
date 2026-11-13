// Decides a student's citizenship group from what they typed. This is the
// single source of truth: the server recomputes it for every profile save and
// every AI request, so a wrong value from the browser can't steer the AI.
//
// Accepts country names, nationality words ("Croatian"), native names
// ("Hrvatska"), any accents/case, dual nationality ("German / US") and
// one-letter typos.

export type CitizenshipGroup = "EU / EFTA" | "Non-EU / EFTA" | "Determined from citizenship";

// EU member states + EFTA states, each with the ways people commonly write them.
const EU_EFTA: Record<string, string[]> = {
  Austria: ["austrian", "österreich"],
  Belgium: ["belgian", "belgië", "belgique", "belgien"],
  Bulgaria: ["bulgarian", "българия", "balgariya"],
  Croatia: ["croatian", "hrvatska", "hrvat"],
  Cyprus: ["cypriot", "κύπρος", "kypros"],
  Czechia: ["czech republic", "czech", "česko", "česká republika"],
  Denmark: ["danish", "dane", "danmark"],
  Estonia: ["estonian", "eesti"],
  Finland: ["finnish", "finn", "suomi"],
  France: ["french"],
  Germany: ["german", "deutschland", "deutsch"],
  Greece: ["greek", "hellenic", "hellas", "ελλάδα", "ellada"],
  Hungary: ["hungarian", "magyarország", "magyar"],
  Ireland: ["irish", "éire"],
  Italy: ["italian", "italia"],
  Latvia: ["latvian", "latvija"],
  Lithuania: ["lithuanian", "lietuva"],
  Luxembourg: ["luxembourgish", "luxembourger", "luxemburg", "lëtzebuerg"],
  Malta: ["maltese"],
  Netherlands: ["dutch", "holland", "nederland", "the netherlands"],
  Poland: ["polish", "pole", "polska"],
  Portugal: ["portuguese"],
  Romania: ["romanian", "românia"],
  Slovakia: ["slovak", "slovakian", "slovensko"],
  Slovenia: ["slovenian", "slovene", "slovenija"],
  Spain: ["spanish", "españa"],
  Sweden: ["swedish", "swede", "sverige"],
  // EFTA
  Iceland: ["icelandic", "ísland"],
  Liechtenstein: ["liechtensteiner"],
  Norway: ["norwegian", "norge", "noreg"],
  Switzerland: ["swiss", "schweiz", "suisse", "svizzera", "svizra"],
};

/** Lowercase, strip accents and filler words like "citizen" or "nationality". */
function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b(citizen(ship)?|nationality|national|passport|from)\b/g, " ")
    .replace(/[^\p{L}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// normalised alias -> canonical country name
const ALIASES = new Map<string, string>();
for (const [country, aliases] of Object.entries(EU_EFTA)) {
  for (const alias of [country, ...aliases]) ALIASES.set(normalize(alias), country);
}

/** Edit distance where a swap of two neighbouring letters ("Croatai") counts as one edit. */
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) d[i][0] = i;
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/** Match one nationality to an EU/EFTA country, allowing a one-letter typo on longer words. */
function matchCountry(part: string): string | null {
  const exact = ALIASES.get(part);
  if (exact) return exact;
  if (part.length < 6) return null; // short words: exact only, to avoid false matches
  for (const [alias, country] of ALIASES) {
    if (alias.length >= 6 && editDistance(part, alias) <= 1) return country;
  }
  return null;
}

export function classifyCitizenship(nationality: string): {
  group: CitizenshipGroup;
  country: string | null;
} {
  // Dual nationality: "German / US", "Croatian and Canadian" — any EU/EFTA one counts.
  const parts = nationality
    .split(/\s*(?:[\/,;&+]|\band\b|\bund\b)\s*/i)
    .map(normalize)
    .filter(Boolean);
  if (parts.length === 0) return { group: "Determined from citizenship", country: null };

  for (const part of parts) {
    const country = matchCountry(part);
    if (country) return { group: "EU / EFTA", country };
  }
  return { group: "Non-EU / EFTA", country: null };
}

/** Return the profile with `status` recomputed from `nationality` on the server. */
export function withServerStatus<T extends Record<string, unknown>>(profile: T): T {
  const nationality = typeof profile.nationality === "string" ? profile.nationality : "";
  if (!nationality.trim()) return profile;
  return { ...profile, status: classifyCitizenship(nationality).group };
}
