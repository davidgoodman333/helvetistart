// Curated list of sources used to build the LOCAL knowledge base.
//
// - Web sources: every host MUST also be on the allow-list in allowlist.ts.
//   HTML pages and PDFs are both supported.
// - Local sources (`localPath`): documents kept in /server/knowledge, e.g. the
//   coordinator notes. They are never fetched from the network.
//
// `appliesTo` lets retrieval tailor results to the student's citizenship group.
// Non-EU sources stay in the list even while plans are EU-only, so the same
// infrastructure can serve other scenarios later.

export type Audience = "all" | "eu" | "non-eu";
export type Topic =
  | "housing"
  | "visa"
  | "registration"
  | "insurance"
  | "bank"
  | "work"
  | "phone"
  | "transport"
  // Payroll deductions (AHV/IV/EO, unemployment, accident insurance), AHV number.
  // Not used by any plan step (see STEP_TOPICS): chat answers only.
  | "social-insurance"
  | "tax"
  // Radio/TV household fee, leaving Switzerland: one plan step each.
  | "household-fee"
  | "departure"
  | "general";

/** A host university whose own pages only apply to its own students. */
export type Institution = "bfh" | "unibe";

export type Source = {
  id: string;
  title: string;
  /** Web URL, or a `local:` id for documents in /server/knowledge. */
  url: string;
  /** Path relative to /server/knowledge for local documents. */
  localPath?: string;
  topic: Topic;
  appliesTo: Audience;
  lang: "en" | "de" | "fr" | "it";
  /** "official" = government/university; "coordinator" = practical guidance. */
  authority: "official" | "coordinator";
  /** Override the default chunk cap for long documents (guides, PDFs). */
  maxChunks?: number;
  /**
   * Set on a university's own pages: they are only searched for that
   * university's students (a University of Bern student is never sent to BFH's
   * housing office). Students at another institution see every source.
   */
  institution?: Institution;
};

export const SOURCES: Source[] = [
  // --- Coordinator guidance (local, editable) --------------------------------
  {
    id: "coordinator-eu-exchange",
    title: "HelvetiStart coordinator notes — EU/EFTA exchange students",
    url: "local:coordinator-eu-exchange",
    localPath: "coordinator-eu-exchange.md",
    topic: "general",
    appliesTo: "eu",
    lang: "en",
    authority: "coordinator",
  },

  {
    // Tips that don't depend on citizenship (phone, bank account, papers).
    id: "coordinator-practical",
    title: "HelvetiStart coordinator notes — practical tips for all students",
    url: "local:coordinator-practical",
    localPath: "coordinator-practical.md",
    topic: "general",
    appliesTo: "all",
    lang: "en",
    authority: "coordinator",
  },

  // --- Federal: entry, residence, work (SEM) ---------------------------------
  // SEM's old overview page is now only a menu (no rules on it), so it is not
  // a source any more; the pages below carry the actual text.
  {
    id: "sem-entry-faq",
    title: "SEM FAQ — entry into Switzerland",
    url: "https://www.sem.admin.ch/en/faq-entry",
    topic: "visa",
    appliesTo: "non-eu",
    lang: "en",
    authority: "official",
  },
  {
    id: "sem-work-faq",
    title: "SEM FAQ — working in Switzerland",
    url: "https://www.sem.admin.ch/en/faq-working",
    topic: "work",
    appliesTo: "all",
    lang: "en",
    authority: "official",
  },
  {
    id: "sem-euefta",
    title: "SEM — EU/EFTA citizens living and working in Switzerland",
    url: "https://www.sem.admin.ch/en/eu-efta-citizens-living-and-working-in-switzerland",
    topic: "visa",
    appliesTo: "eu",
    lang: "en",
    authority: "official",
  },
  {
    id: "sem-euefta-faq",
    title: "SEM FAQ — EU/EFTA citizens in Switzerland",
    url: "https://www.sem.admin.ch/en/faq-free-movement-of-persons",
    topic: "registration",
    appliesTo: "eu",
    lang: "en",
    authority: "official",
  },
  {
    id: "sem-residence-euefta",
    title: "SEM — residence permits for EU/EFTA nationals",
    url: "https://www.sem.admin.ch/en/residence-permits-for-eu-efta-nationals",
    topic: "visa",
    appliesTo: "eu",
    lang: "en",
    authority: "official",
  },
  {
    id: "sem-nonworking-factsheet",
    title: "SEM factsheet — residing in Switzerland without gainful activity (EU/EFTA, incl. students)",
    url: "https://www.sem.admin.ch/dam/en/sd-web/18D9drpVemZ0/fs-nichterwerbstaetige.pdf",
    topic: "registration",
    appliesTo: "eu",
    lang: "en",
    authority: "official",
  },

  // ch.ch pages are not used: the portal sends programs like this one an empty
  // page and fills in the text with JavaScript, so there is nothing to read.
  // The same topics are covered by SEM, City of Bern and the pages below.

  {
    id: "sem-entry-with-visa",
    title: "SEM — entry with a visa (non-EU/EFTA nationals)",
    url: "https://www.sem.admin.ch/en/entry-with-visa",
    topic: "visa",
    appliesTo: "non-eu",
    lang: "en",
    authority: "official",
  },
  {
    id: "eda-visa-requirements",
    title: "Federal Department of Foreign Affairs — visa requirements for entry into Switzerland",
    url: "https://www.eda.admin.ch/en/visa-requirements-for-entry-into-switzerland",
    topic: "visa",
    appliesTo: "non-eu",
    lang: "en",
    authority: "official",
  },

  // --- Federal: health insurance (BAG / FOPH) --------------------------------
  {
    id: "bag-students",
    title: "Health insurance: foreign students in Switzerland — FOPH",
    url: "https://www.bag.admin.ch/en/health-insurance-foreign-students-in-switzerland",
    topic: "insurance",
    appliesTo: "all",
    lang: "en",
    authority: "official",
  },
  {
    id: "bag-residents",
    title: "Health insurance: requirement to obtain insurance (residents) — FOPH",
    url: "https://www.bag.admin.ch/en/health-insurance-requirement-to-obtain-insurance-for-persons-resident-in-switzerland",
    topic: "insurance",
    appliesTo: "all",
    lang: "en",
    authority: "official",
  },

  // --- Canton of Bern ---------------------------------------------------------
  {
    id: "bern-migration-service",
    title: "Bern Migration Service — residence permits",
    url: "https://www.migration.sid.be.ch/de/start.html",
    topic: "visa",
    appliesTo: "all",
    lang: "en",
    authority: "official",
  },
  {
    id: "asv-exemption-info",
    title: "Canton of Bern Social Insurance Office (ASV) — exemption from compulsory health insurance (info sheet, German)",
    url: "https://www.asv.dij.be.ch/content/dam/asv_dij/dokumente/de/kvg-obligatorium/Informationen%20Befreiung%20von%20der%20Versicherungspflicht%20in%20der%20Schweiz_de.pdf",
    topic: "insurance",
    appliesTo: "all",
    lang: "de",
    authority: "official",
  },
  {
    id: "asv-form-a",
    title: "Canton of Bern ASV — Form A: exemption for people in education (German)",
    url: "https://www.asv.dij.be.ch/content/dam/asv_dij/dokumente/de/kvg-obligatorium/Formular%20A-Aus-+Weiterbildung_de.pdf",
    topic: "insurance",
    appliesTo: "all",
    lang: "de",
    authority: "official",
  },
  {
    id: "asv-compulsory-brochure",
    title: "Canton of Bern ASV — brochure: compulsory health insurance in Switzerland (German)",
    url: "https://www.asv.dij.be.ch/content/dam/asv_dij/dokumente/de/kvg-obligatorium/O_Brosch%C3%BCre%20Versicherungspflicht_de.pdf",
    topic: "insurance",
    appliesTo: "all",
    lang: "de",
    authority: "official",
  },
  {
    id: "asv-basic-insurance",
    title: "Canton of Bern ASV — basic health insurance in Switzerland (German)",
    url: "https://www.asv.dij.be.ch/de/start/themen/obli/obli_grundversicherung.html",
    topic: "insurance",
    appliesTo: "all",
    lang: "de",
    authority: "official",
  },

  {
    id: "migration-be-third-country",
    title: "Canton of Bern Migration Service — entry for non-EU/EFTA nationals, incl. studies (German)",
    url: "https://www.migration.sid.be.ch/de/start/einreise/buerger-drittstaaten.html",
    topic: "visa",
    appliesTo: "non-eu",
    lang: "de",
    authority: "official",
  },
  {
    id: "migration-be-permit-b",
    title: "Canton of Bern Migration Service — residence permit B (German)",
    url: "https://www.migration.sid.be.ch/de/start/aufenthalt/ausweis-b.html",
    topic: "registration",
    appliesTo: "all",
    lang: "de",
    authority: "official",
  },
  {
    id: "weu-hiring-third-country",
    title: "Canton of Bern Office for Economic Affairs — hiring people from non-EU/EFTA countries (German)",
    url: "https://www.weu.be.ch/de/start/themen/wirtschaft-und-arbeit/unternehmen/auslaendische-erwerbstaetige/anstellen-aus-drittstaaten.html",
    topic: "work",
    appliesTo: "non-eu",
    lang: "de",
    authority: "official",
  },

  // --- City of Bern -----------------------------------------------------------
  {
    id: "bern-education-stay",
    title: "City of Bern — stay for education and training (registration, permits)",
    url: "https://www.bern.ch/themen/auslanderinnen-und-auslander/einreise-und-aufenthalt/aufenthalt-zur-aus-und-weiterbildung",
    topic: "registration",
    appliesTo: "all",
    lang: "de",
    authority: "official",
  },
  {
    id: "bern-work-permits",
    title: "City of Bern — work permits",
    url: "https://www.bern.ch/themen/auslanderinnen-und-auslander/einreise-und-aufenthalt/arbeiten-in-bern/arbeitsbewilligungen",
    topic: "work",
    appliesTo: "all",
    lang: "de",
    authority: "official",
  },
  {
    id: "bern-city-moving",
    title: "Moving house, change of address, permits — City of Bern",
    url: "https://www.bern.ch/en/topics/personal-family-matters/moving-house-change-of-address-identity",
    topic: "registration",
    appliesTo: "all",
    lang: "en",
    authority: "official",
  },
  {
    id: "bern-city-work-tax",
    title: "Starting work and taxes — City of Bern",
    url: "https://www.bern.ch/en/topics/foreign-nationals/starting-work-and-taxes",
    topic: "work",
    appliesTo: "all",
    lang: "en",
    authority: "official",
  },

  // --- BFH (host university) -------------------------------------------------
  {
    id: "bfh-housing",
    title: "BFH — accommodation for students",
    url: "https://www.bfh.ch/en/studies/studies-life/wohnen/",
    topic: "housing",
    appliesTo: "all",
    lang: "en",
    authority: "official",
    institution: "bfh",
  },
  {
    id: "bfh-insurance",
    title: "BFH — insurance and compulsory service",
    url: "https://www.bfh.ch/en/studies/studies-life/versicherungen-dienstpflicht/",
    topic: "insurance",
    appliesTo: "all",
    lang: "en",
    authority: "official",
    institution: "bfh",
  },
  {
    id: "bfh-foreign-students",
    title: "BFH — studying in Switzerland (foreign students)",
    url: "https://www.bfh.ch/en/studies/international-study/foreign-students/",
    topic: "general",
    appliesTo: "all",
    lang: "en",
    authority: "official",
    institution: "bfh",
  },
  {
    id: "bfh-student-guide",
    title: "BFH International Student Guide (PDF)",
    url: "https://www.bfh.ch/dam/jcr:3ed7c433-b7c7-4873-bd35-da942d315767/BFH_International-Student-Guide.pdf",
    topic: "general",
    appliesTo: "all",
    lang: "en",
    authority: "official",
    institution: "bfh",
  },
  {
    id: "bfh-health-factsheet",
    title: "BFH factsheet — health insurance in Switzerland (PDF)",
    url: "https://www.bfh.ch/dam/jcr:c66705ad-687f-4734-bc59-3159a82ddd05/Factsheet%20Health%20Insurance%20in%20Switzerland.pdf",
    topic: "insurance",
    appliesTo: "all",
    lang: "en",
    authority: "official",
    institution: "bfh",
  },
  {
    id: "bfh-student-guide-web",
    title: "BFH — International Student Guide",
    url: "https://www.bfh.ch/en/studies/international-study/foreign-students/student-guide/",
    topic: "general",
    appliesTo: "all",
    lang: "en",
    authority: "official",
    institution: "bfh",
  },
  {
    id: "bfh-incoming-checklist",
    title: "BFH — checklist for incoming exchange students (PDF)",
    url: "https://www.bfh.ch/dam/jcr:94b56c49-07c1-4c98-9f0b-cf3a4a82701f/checkliste-studierende-incoming-studium-en.pdf",
    topic: "general",
    appliesTo: "all",
    lang: "en",
    authority: "official",
    institution: "bfh",
  },
  {
    id: "bfh-business-mobility",
    title: "BFH Business School — mobility factsheet for incoming students 2026/27 (PDF)",
    url: "https://www.bfh.ch/dam/jcr:50194275-9509-42dd-bc26-574769eb4431/Mobility%20Factsheet_BFH_Business_School_2026_2027.pdf",
    topic: "general",
    appliesTo: "all",
    lang: "en",
    authority: "official",
    institution: "bfh",
  },

  // --- Social insurance: what is deducted from a salary ----------------------
  {
    id: "ahv-salary-contributions",
    title: "AHV/IV leaflet 2.01 — salary contributions to AHV, IV and EO (PDF)",
    url: "https://www.ahv-iv.ch/p/2.01.e",
    topic: "social-insurance",
    appliesTo: "all",
    lang: "en",
    authority: "official",
  },
  {
    id: "ahv-student-contributions",
    title: "AHV/IV leaflet 2.10 — contributions of students to AHV, IV and EO (PDF, German)",
    url: "https://www.ahv-iv.ch/p/2.10.d",
    topic: "social-insurance",
    appliesTo: "all",
    lang: "de",
    authority: "official",
  },
  {
    id: "ahv-non-employed-contributions",
    title: "AHV/IV leaflet 2.03 — contributions of non-employed persons (PDF)",
    url: "https://www.ahv-iv.ch/p/2.03.e",
    topic: "social-insurance",
    appliesTo: "all",
    lang: "en",
    authority: "official",
  },
  {
    // Covers every branch: AHV/IV/EO, unemployment, accident, health, family allowances.
    id: "ahv-social-security-overview",
    title: "Social security in Switzerland 2026 — overview of all social insurances (PDF)",
    url: "https://www.ahv-iv.ch/p/890.e",
    topic: "social-insurance",
    appliesTo: "all",
    lang: "en",
    authority: "official",
    maxChunks: 260,
  },
  {
    id: "zas-ahv-number",
    title: "The AHV number — Central Compensation Office (ZAS)",
    url: "https://www.zas.admin.ch/de/ahv-nummer-identifikator",
    topic: "social-insurance",
    appliesTo: "all",
    lang: "de",
    authority: "official",
  },
  {
    id: "zas-ahv-number-faq",
    title: "FAQ: the AHV number for private persons — Central Compensation Office (ZAS)",
    url: "https://www.zas.admin.ch/de/faq-ahv-nummer-fuer-private",
    topic: "social-insurance",
    appliesTo: "all",
    lang: "de",
    authority: "official",
  },
  {
    id: "suva-who-is-insured",
    title: "Accident insurance (UVG): who is insured, and when — Suva",
    url: "https://www.suva.ch/de-ch/versicherung/unfallversicherung/unfallversicherung-uvg/unfallversicherung-wer-ist-versichert",
    topic: "social-insurance",
    appliesTo: "all",
    lang: "de",
    authority: "official",
  },

  // --- Tax at source (withholding tax on wages) ------------------------------
  {
    id: "estv-tax-at-source",
    title: "Swiss tax at source (Quellensteuer) — Federal Tax Administration",
    url: "https://www.estv.admin.ch/de/quellensteuer",
    topic: "tax",
    appliesTo: "all",
    lang: "de",
    authority: "official",
  },
  {
    id: "be-tax-at-source-who",
    title: "Who is subject to tax at source — Canton of Bern tax administration",
    url: "https://www.sv.fin.be.ch/de/start/themen/quellensteuer/wer-unterliegt-der-quellensteuer.html",
    topic: "tax",
    appliesTo: "all",
    lang: "de",
    authority: "official",
  },
  {
    id: "be-taxinfo-tax-at-source-employees",
    title: "TaxInfo: employees subject to tax at source — Canton of Bern",
    url: "https://www.taxinfo.sv.fin.be.ch/taxinfo/aebf2cdd-8325-4eb9-ac8a-8f833f3cb9f7",
    topic: "tax",
    appliesTo: "all",
    lang: "de",
    authority: "official",
  },

  // --- Health insurance premium reduction ------------------------------------
  {
    id: "bag-premium-subsidies",
    title: "Health insurance: premium subsidies — Federal Office of Public Health",
    url: "https://www.bag.admin.ch/en/health-insurance-premium-subsidies",
    topic: "insurance",
    appliesTo: "all",
    lang: "en",
    authority: "official",
  },
  {
    id: "bag-premium-faq",
    title: "Health insurance premiums and costs: FAQ — Federal Office of Public Health",
    url: "https://www.bag.admin.ch/en/premiums-and-costs-answers-to-frequently-asked-questions",
    topic: "insurance",
    appliesTo: "all",
    lang: "en",
    authority: "official",
  },
  {
    id: "asv-premium-reduction-faq",
    title: "FAQ: premium reduction (Prämienverbilligung) — Canton of Bern social insurance office",
    url: "https://www.asv.dij.be.ch/de/start/themen/faq/faq_pv.html",
    topic: "insurance",
    appliesTo: "all",
    lang: "de",
    authority: "official",
  },
  // How the online application is handed in: the release receipt
  // (Freigabequittung) and any documents not uploaded go by post.
  {
    id: "asv-premium-reduction-apply",
    title:
      "Applying for premium reduction (Prämienverbilligung beantragen): online application, release receipt (Freigabequittung) by post — Canton of Bern social insurance office",
    url: "https://www.asv.dij.be.ch/de/start/themen/pv/pv_anrecht-auf-pv-beantragen.html",
    topic: "insurance",
    appliesTo: "all",
    lang: "de",
    authority: "official",
  },

  // --- SEM: permits and entry (added with the 2026 site restructure) ----------
  {
    id: "sem-permit-b-euefta",
    title: "SEM — B EU/EFTA permit (resident foreign nationals)",
    url: "https://www.sem.admin.ch/en/b-eu-efta-permit-resident-foreign-nationals",
    topic: "registration",
    appliesTo: "eu",
    lang: "en",
    authority: "official",
  },
  {
    id: "sem-permit-l-euefta",
    title: "SEM — L EU/EFTA permit (short-term residents)",
    url: "https://www.sem.admin.ch/en/l-eu-efta-permit-short-term-residents",
    topic: "registration",
    appliesTo: "eu",
    lang: "en",
    authority: "official",
  },
  {
    id: "sem-residence-non-eu",
    title: "SEM — residence permits for non-EU/EFTA nationals",
    url: "https://www.sem.admin.ch/en/residence-permits-for-non-eu-efta-nationals",
    topic: "visa",
    appliesTo: "non-eu",
    lang: "en",
    authority: "official",
  },
  {
    id: "sem-entry-without-visa",
    title: "SEM — entry without a visa (non-EU/EFTA nationals)",
    url: "https://www.sem.admin.ch/en/entry-without-visa",
    topic: "visa",
    appliesTo: "non-eu",
    lang: "en",
    authority: "official",
  },
  {
    id: "sem-visa-application-form",
    title: "SEM — visa application form and where to submit it",
    url: "https://www.sem.admin.ch/en/visa-application-form",
    topic: "visa",
    appliesTo: "non-eu",
    lang: "en",
    authority: "official",
  },
  {
    id: "sem-biometric-permits",
    title: "SEM — biometric residence permits for foreign nationals",
    url: "https://www.sem.admin.ch/en/biometric-residence-permits-for-foreign-nationals",
    topic: "registration",
    appliesTo: "non-eu",
    lang: "en",
    authority: "official",
  },
  {
    id: "bag-insurance-requirement",
    title: "Health insurance: requirement to obtain insurance (overview) — FOPH",
    url: "https://www.bag.admin.ch/en/health-insurance-requirement-to-obtain-insurance",
    topic: "insurance",
    appliesTo: "all",
    lang: "en",
    authority: "official",
  },

  // --- Canton and City of Bern: short stays, arriving, leaving ----------------
  {
    id: "migration-be-permit-l",
    title: "Canton of Bern Migration Service — short-term residence permit L (German)",
    url: "https://www.migration.sid.be.ch/de/start/aufenthalt/ausweis-l.html",
    topic: "registration",
    appliesTo: "all",
    lang: "de",
    authority: "official",
  },
  {
    id: "bern-new-in-bern",
    title: "City of Bern — new in Bern (arriving and registering, German)",
    url: "https://www.bern.ch/themen/zuzug-umzug-wegzug/neu-in-bern",
    topic: "registration",
    appliesTo: "all",
    lang: "de",
    authority: "official",
  },
  {
    id: "bern-moving-overview",
    title: "City of Bern — moving in, moving house and moving away (German)",
    url: "https://www.bern.ch/themen/zuzug-umzug-wegzug/",
    topic: "departure",
    appliesTo: "all",
    lang: "de",
    authority: "official",
  },
  {
    id: "bern-departure-abroad-form",
    title: "City of Bern — online form for moving abroad (deregistration, German)",
    url: "https://www.bern.ch/themen/zuzug-umzug-wegzug/formular-wegzug-ausland",
    topic: "departure",
    appliesTo: "all",
    lang: "de",
    authority: "official",
  },

  // --- Radio and television fee (Serafe) --------------------------------------
  {
    id: "bakom-fee-private-households",
    title: "Radio and television fee for private households — Federal Office of Communications",
    url: "https://www.bakom.admin.ch/en/fee-for-private-households",
    topic: "household-fee",
    appliesTo: "all",
    lang: "en",
    authority: "official",
  },
  {
    id: "bakom-fee-collective-households",
    title: "Radio and television fee for collective households (incl. student hostels) — Federal Office of Communications",
    url: "https://www.bakom.admin.ch/en/fee-for-collective-households",
    topic: "household-fee",
    appliesTo: "all",
    lang: "en",
    authority: "official",
  },

  // --- University of Bern (host university) -----------------------------------
  {
    id: "unibe-entry-residence",
    title: "University of Bern — entry and residence regulations for incoming students",
    url: "https://www.unibe.ch/studies/mobility/incoming/general_information/einreise_und_aufenthaltsbestimmungen/index_eng.html",
    topic: "registration",
    appliesTo: "all",
    lang: "en",
    authority: "official",
    institution: "unibe",
  },
  {
    id: "unibe-health-insurance",
    title: "University of Bern — health insurance for incoming students",
    url: "https://www.unibe.ch/studies/mobility/incoming/general_information/health_insurance/index_eng.html",
    topic: "insurance",
    appliesTo: "all",
    lang: "en",
    authority: "official",
    institution: "unibe",
  },
  {
    id: "unibe-accommodation",
    title: "University of Bern — accommodation and living for incoming students",
    url: "https://www.unibe.ch/studies/mobility/incoming/general_information/accommodation___living/index_eng.html",
    topic: "housing",
    appliesTo: "all",
    lang: "en",
    authority: "official",
    institution: "unibe",
  },
  {
    id: "unibe-financial-matters",
    title: "University of Bern — financial matters for incoming students",
    url: "https://www.unibe.ch/studies/mobility/incoming/general_information/financial_matters/index_eng.html",
    topic: "general",
    appliesTo: "all",
    lang: "en",
    authority: "official",
    institution: "unibe",
  },
];
