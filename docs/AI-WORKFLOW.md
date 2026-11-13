# How HelvetiStart's AI works, and why it was built this way

This document explains how the AI in HelvetiStart turns a student's onboarding answers into a relocation plan, what was changed in November 2026 to make it more correct and faster, and the reasoning behind each decision. It is written for someone who knows the app but not the vocabulary of AI systems, so each concept is explained where it first appears.

## 1. The short version

HelvetiStart does not ask a language model "what should this student do?". A small model running on a laptop would answer fluently and get things wrong: invent a deadline, apply another country's work rule, send an EU student to a non-EU form.

Instead the work is divided so that each part is done by whatever does it reliably:

| Part | Done by | Why |
|---|---|---|
| Which steps are in the plan, their order, their form, why each one applies | **Rules** (ordinary code) | These follow exactly from the student's answers. Code is right every time and can be tested. |
| Finding the official text for each step, looking up checked figures, working out dates | **Tools** (functions the system calls) | A model cannot browse, remember accurately or do calendar arithmetic. |
| Explaining the step in plain English from German and English sources | **The model** (Qwen3 8B, running locally) | Reading and rewriting text is what a language model is good at. |
| Removing any number, deadline or document the sources don't contain | **Checks** (code) | A model cannot be trusted to police itself. |

The model is the smallest part of the system on purpose. Most of the correctness comes from what surrounds it.

## 2. Workflow or agent?

AI systems are usually built in one of two shapes.

- A **workflow** is a fixed sequence of steps written by the developer. The model is called at set points to do one narrow job each time.
- An **agent** is a model that decides for itself what to do next. It is given tools and a goal, and it loops: think, call a tool, read the result, think again.

Agents are flexible but slower, harder to test and more likely to go wrong, especially with a small model. The usual advice is to use the simplest shape that solves the problem, and to choose an agent only when the steps cannot be known in advance.

HelvetiStart uses both, each where it fits:

- **The plan is a workflow.** Every student needs the same lookups in the same order, so nothing is left to the model's judgement except the wording.
- **The chat is a small, bounded agent.** A question can be about anything, so the model is allowed to call tools, for at most two rounds per question.

## 3. What a "tool" is

A language model can only produce text. A tool is a function in our code that we describe to the model: its name, when to use it, and what arguments it takes. Instead of answering, the model can reply "call `search_sources` with this query". The server runs the function and gives the result back, and the model continues with real information instead of a guess.

Three things make a tool good:

1. **One job, clearly described.** The description is what the model reads to decide when to use it.
2. **Narrow inputs.** A fixed list of topics rather than free text, a date in one format.
3. **Trusted outputs.** A tool only returns things the system already trusts.

The model never touches the database, the network or the clock. It can do nothing that is not in the list below. This list is the model's entire reach, which is what makes the system safe to reason about.

HelvetiStart's tools are defined in `server/src/tools.ts`:

| Tool | What it returns | Why it exists |
|---|---|---|
| `search_sources` | Numbered passages from the official sources, already filtered to the student's citizenship group and university | The model must answer from official text, not from memory |
| `get_key_facts` | Figures a person has approved (work hours, deadlines) | The numbers that matter most are never left to the model |
| `get_plan_steps` | The student's steps, as decided by the rules | So the chat and the plan can never disagree |
| `calculate_deadline` | A calendar date from a start date and a period | Models are unreliable at date arithmetic |
| `find_form` | Official forms from a hand-checked list | The model can never invent a link |

The plan calls these functions from code in a fixed order. The chat lets the model choose among them.

## 4. What a "rule" is

There are three kinds of rules in the system, and it helps to keep them apart.

**Decision rules** (`server/src/plan-rules.ts`) are code. They read the onboarding answers and decide the plan's structure. Examples: a non-EU student gets a "visa and residence permit" step before travelling; a student who will work cannot get the health-insurance exemption form; a student staying longer than a year gets "renew your permit" instead of "deregister". These rules deliberately contain no figures. Hour limits, deadlines and fees change with the law, so they come from the sources.

**Instructions** (the system prompt) tell the model how to write: use only the evidence, write in plain English, address the student as "you", every number must appear in the evidence.

**Guardrails** (`server/src/grounding.ts`, `server/src/facts.ts`) are code that checks the model's output after it is written. An instruction is a request; a guardrail is enforcement. For example, the prompt says "every number must come from the evidence", and then the code actually looks for each number in the evidence and deletes the sentence if it is not there.

The principle: **if a rule matters, enforce it in code. Use the prompt only for what code cannot check**, such as tone and clarity.

## 5. How a plan is built

1. **Classify.** The server works out the citizenship group (EU/EFTA or not) from the nationality the student typed. This is never left to the model, which sometimes misremembers which countries are in the EU.
2. **Decide the steps.** The rules produce an ordered list of 5 to 10 steps. Each one carries a title, a phase, a form, the reason it is in this student's plan, a rough effort, and a note saying what the text must cover.
3. **Fetch evidence.** For each step, the search returns the three passages that best match it, restricted to sources about that topic, that citizenship group and that university. Approved key facts for the step are added in front.
4. **Write.** The model is called once per step. It sees only that step and its evidence, and returns four things in a fixed structure: an explanation, a deadline if the evidence states one, the documents the evidence names (each with the words it was taken from), and which passage supports it.
5. **Check.** Code removes an explanation whose numbers are not in the evidence, a deadline the evidence does not back, and any document whose quote is not really in the evidence. It adds an approved fact the model left out, and turns "within 14 days of arrival" into "by 7 Sept 2026" using the student's arrival date.
6. **Store.** The checked text for each step is saved, keyed by everything the model was shown.

## 6. What was changed, and why

Each change below started from a measured or observed problem.

### 6.1 The plan covered too little of a student's stay

**Problem.** The rules knew seven steps, all about arriving. Nothing covered what a working student sees on a payslip, the household radio and TV fee, renewing a permit, or deregistering before leaving, which every exchange student must do.

**Change.** Four steps were added: payslip deductions (for students who work), the radio and TV fee, permit renewal (stays over a year) and deregistration (everyone else). A plan now runs from before arrival to departure.

**Why rules and not the model.** Whether a student needs a step follows from their answers. Asking the model to "suggest further steps" would produce plausible but unverifiable suggestions.

### 6.2 Several sources had silently died

**Problem.** The federal migration office (SEM) restructured its website. Six of its pages in the source list returned "not found", and three more only worked through redirects. The knowledge base was still answering from old copies and would have lost them at the next rebuild.

**Change.** All SEM addresses were updated, one page that is now only a menu was removed, and 17 official sources were added (62 sources in total): SEM permit and visa pages, the Canton's short-stay permit page, the City of Bern's arrival and departure pages, the federal pages on the radio and TV fee, and four University of Bern pages. The fetcher now retries when a site returns a temporary error.

Two steps, "get a phone number" and "open a bank account", have no official rule behind them. When their evidence came from whichever university page happened to mention a phone or a bank, the model drifted into unrelated subjects from that page. Their evidence is now the coordinator's notes only, and the tips that apply to every student were moved into their own notes file so non-EU students get them too.

### 6.3 Students were shown another university's pages

**Problem.** Every university page in the knowledge base was from BFH. A University of Bern student was given BFH's housing office and BFH's guide as sources.

**Change.** A source can now belong to one institution. Its passages are only searched for that university's students. Students at any other institution still see everything.

### 6.4 The model was inventing the personal reason, the effort and the documents

**Problem.** In the old plan, the "for you" sentence was generic filler ("You're coming for an exchange semester and need to manage your money"), the time estimate was made up, and documents were not checked at all. A bank-account step asked for "proof of insurance", which no source mentions.

**Change.**
- The **reason** now comes from the rules, which know exactly which answer put the step in the plan ("You plan to work in Switzerland, and a job ends the option of staying on your home insurance").
- The **effort** is a coordinator's estimate stored with the step.
- Each **document** must come with the words of the evidence that name it. Code checks that those words really are in the evidence and drops the document otherwise.

This also removed about a third of what the model had to write, which made it faster.

### 6.5 The checked figures were never used

**Problem.** The system extracts 13 key facts (work hours, deadlines) from the sources and only uses them once a person has approved them. None had ever been approved, so the whole mechanism was switched off. One extracted fact was also wrong: asked where to apply for a visa, the extractor had returned "register with the municipality within 14 days".

**Change.**
- Extraction prefers the authorities' own pages over a university's summary of them.
- The question behind the wrong fact was reworded so it can no longer be confused with registering after arrival.
- `npm run facts` lists every fact with its quote and source, and approves or rejects it in one command.
- When an approved fact states a step's deadline, the code writes the deadline and the date. The model is not involved.

**Tried and removed.** A second model call that reviews each extracted fact ("does this quote really answer this question?") is a well-known pattern. It was built and tested on the known-wrong fact with two different prompts, and it passed the wrong fact both times. A check that does not catch the one error it was built for only adds false confidence, so it was taken out. The 8B model is not a reliable judge of its own extractions; a person is. This is why the approval step in section 8 matters.

### 6.6 A plan took up to a minute, and more steps would have made it slower

**Problem.** The whole plan was written in one model call: 21 to 52 seconds for up to 7 steps. With four more steps the longest plans would have passed a minute. The plan was stored only as a whole, so any difference between two students meant writing everything again.

**Change.** The model is now called once per step, and each step is stored on its own.

- **A step's text depends only on the step.** Because the personal reason moved to the rules, the model's text for "Register with the City of Bern as an EU exchange student" is identical for every such student, whatever their housing, insurance or work answers. Two students with different plans share most of their steps.
- **Steps are written ahead of time.** The onboarding answers are multiple choice, so every step any student can get is known in advance. After the server starts or the sources are rebuilt, a background job writes them all. A student's own request always goes first.
- **The app shows progress.** The plan is sent as a stream: the list of steps arrives at once and is shown on the loading screen, and each step is ticked off as its details are written.
- **Less to write.** The model generates about 19 tokens per second on this laptop, so the length of its output is what a student waits for. Each step's explanation is limited to 60 words.

One setting outside the app matters for a plan with nothing stored: started with `OLLAMA_NUM_PARALLEL=2`, Ollama writes two steps at the same time, which is about 1.6 times faster. Without it the app still works, more slowly (see section 7).

One call per step also improves the text. A small model given one step and three passages confuses far less than one given seven steps and twenty passages.

### 6.7 Search

**Change.** Each passage is now embedded together with the title of the page it came from. A passage such as "You must apply within three months" says nothing about what is being applied for until it carries its page's name. Pages are also read from their main content only, without menus and cookie notices, and character codes such as `&#x2F;` are decoded.

**A change that was tested and not switched on.** Combining meaning-based search with keyword search is a common recommendation. It was built and measured, and on this knowledge base it made results slightly worse (see section 7): the questions are in English, many of the best sources are in German, and keyword matching cannot cross languages. It is in the code, set to off, with the measurement that justifies it. See `RETRIEVAL_LEXICAL_WEIGHT`.

### 6.8 The chat can use tools

The chat still receives the best-matching passages up front, so most questions need no tool call. The model may now also search again, ask for a date, look up a form or read the student's plan, for at most two rounds. Passages it fetches are numbered and cited like the rest, and pass through the same number check.

A lesson from testing: with the tool guidance placed among the many rules of the system prompt, the model never called a tool. Moved to a short list directly after the student's question ("if they want a calendar date, call `calculate_deadline`"), it calls the right tool and leaves plain questions alone. Asked "I arrive on 24 August 2026, by what exact date do I have to register?", it now calls `calculate_deadline` and answers 7 Sept 2026; before, it worked a date out itself and the number check deleted it. A tool call adds 3 to 6 seconds to an answer.

### 6.9 The chat said "Yes" to a question whose answer is "No"

**Problem.** Asked "Can I take Swisscare student insurance when I work?", the chat opened with "Yes, you can…" and then listed the rule that says otherwise: a student who works needs Swiss basic health insurance, and a private insurance is no longer enough. Two causes were found. The example answer in the prompt began with "Yes, but only under certain conditions", and the model copied that opening for almost every question. And the model was shown the rules for a working student and a non-working student at the same time, and mixed them.

**Change.**
- The server now reads from the question whether it is about working or not working ("when I work", "if I don't work") and gives the model the rules for that one situation only.
- A rule about private and international student insurance was added to what the chat is told: it is not Swiss basic insurance, it can stand in for it only through an exemption the cantonal office approves, and only while the student does not work.
- One guardrail in code: when a question is about insurance while working and the answer still opens with "Yes", the opening sentence is replaced with the rule's own verdict.

Rewording the prompt alone was tried three times first and each version fixed one question and broke another. That is the pattern from section 4 again: a rule that must not come out wrong belongs in code. After the change the question was answered "No" three times out of three. Answers about less common situations can still be wrong in wording, which is why the chat tells students to confirm on the official source.

## 7. Measuring

A change to an AI system is a guess until it is measured. Two test sets were used for every decision above, and both are part of the project.

**`npm run bench`** builds plans for 13 fixed student profiles and checks each one: the right steps, the right forms, no wrong forms, required figures present, every step sourced, no step citing another university. It also times each plan twice, once with nothing stored and once from stored steps, and fails any plan that takes longer than 60 seconds.

**`npm run eval:retrieval`** asks 22 questions students really ask and checks whether a source that holds the answer is among the top three passages.

### Results (11 November 2026, MacBook with Apple M5 and 16 GB, Qwen3 8B)

**Plans**

| | Before | After |
|---|---|---|
| Benchmark profiles passing | 12 of 12 | 13 of 13, with more checks per profile |
| Steps a plan can contain | up to 7 | up to 10 |
| Plan from stored steps | 0.00 s, only for an identical profile | 0.01 s, for any profile whose steps are stored |
| Plan with nothing stored, Ollama default settings | 21 to 52 s | 89 s for the longest plan (10 steps); the shorter ones were not re-measured after the last prompt changes and should take roughly 40 to 60 s |
| Plan with nothing stored, `OLLAMA_NUM_PARALLEL=2` | not measured | 18 to 41 s, average 24 s |
| Time until the student sees their steps | when the whole plan is done | 0.01 s; first details after 5 s |
| Writing steps ahead of time | not done | 39 steps were still missing after the benchmark; the background job wrote them in 296 s (about 8 s each) |
| A profile never requested before, after that job | 21 to 52 s | 0.10 s |

The plan with nothing stored got slower per plan on default settings, because plans are longer and each step is a separate call. That case now only happens when a student arrives before the background writing has finished, for example straight after a rebuild of the sources. In every other case the plan comes from stored steps.

**Search**

| | Questions with a right source in the top 3 | Top-3 passages from a right source |
|---|---|---|
| Before | 19 of 22 | 61% |
| New sources, titles embedded with passages, main content only | 22 of 22 | 76% |
| The same, plus keyword search | 21 of 22 | 65% |

One of the three questions fixed is about the radio and TV fee, which had no source before, so part of the gain is simply from adding sources.

### What the tests do not catch

The checks compare numbers, deadlines and document names with the evidence. They cannot check a claim that contains no number. Reading the plans by hand turned up examples: a step saying a late insurance could mean "fines" where the source says "a surcharge", and a non-EU work step saying work in the semester breaks is "without limits" where the source says full-time and reported by the employer. Approved key facts fix the cases they cover, because an approved fact is put into the text by code. For everything else, the plans should be read by a coordinator from time to time, and each error found should become a benchmark check.

## 8. What a person still has to do

- **Review the key facts.** This is the most valuable thing left to do. Run `npm run facts`, compare each value with its quote, and approve or reject. All 11 extracted facts are waiting, and none is used until approved. Re-check after every rebuild that reports a changed fact. Two facts could not be extracted from the rebuilt sources at all (the deadline for applying for the insurance exemption, and what happens when insurance is taken out late); their questions may need rewording.
- **Start Ollama with `OLLAMA_NUM_PARALLEL=2`** if plans with nothing stored should stay under a minute. It uses about 2 GB more memory.
- **Confirm the new rules.** The four new steps and the effort estimates in `plan-rules.ts` were written from the sources and should be confirmed by a coordinator.
- **Rebuild the sources regularly.** `POST /api/ingest` re-reads every source, reports which pages changed and which plan steps they feed, and re-extracts the facts.
- **Extend the tests.** When a student gets a wrong plan or a wrong answer, add that case to the benchmark first, then fix it.

## 9. What was considered and not done

- **A larger or hosted model.** It would write better text, but the app's promise is that nothing leaves the student's device. The design gets its correctness from rules and checks so that a small local model is enough.
- **Letting the model choose the steps.** Rejected for the reason in 6.1.
- **A reranking model** (a second model that re-orders search results). It would help search quality, but it is another model to keep in memory on a 16 GB laptop. Worth revisiting if the retrieval test starts failing.
- **Public transport and bank steps with official sources.** SBB's site refuses automated readers, and there is no official source on opening a bank account. Those topics rely on the university guides.
- **More onboarding questions.** Asking whether the student has a scholarship, a family, or a car would let the rules decide more steps. This is the most valuable next change, and it is a product decision rather than an AI one.

## 10. Where things are

| File | What it holds |
|---|---|
| `server/src/plan-rules.ts` | Decision rules: which steps, in what order, with which form and reason |
| `server/src/plan.ts` | The plan workflow: evidence, one model call per step, checks, stored steps, background writing |
| `server/src/tools.ts` | The tools and their descriptions |
| `server/src/sources.ts` | The list of official sources |
| `server/src/knowledge.ts` | Reading, splitting, embedding and searching the sources |
| `server/src/facts.ts` | Key facts: extraction, second review, approval, enforcement |
| `server/src/grounding.ts` | The number checks |
| `server/src/index.ts` | The API, including the chat and its tool loop |
| `server/scripts/plan-bench.ts` | Plan benchmark |
| `server/scripts/retrieval-eval.ts` | Search test |
| `server/scripts/facts-review.ts` | Fact review |
| `server/knowledge/` | The coordinator's notes |
| `server/.env.example` | Every setting, with what it does |
