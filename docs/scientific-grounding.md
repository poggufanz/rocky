## Scientific grounding

> *“You teach, I remember. I remind, you understand. This is good trade.”*
>
> Original Rocky project tagline; not a quotation from Project Hail Mary.

Rocky is not a debugging agent. Plenty of tools already write and fix code for you. Rocky exists because of what those tools leave behind: developers who ship code they don't fully understand, and who solve the same problem twice because the first solution never made it into memory. Both problems are documented in the research below.

### 1. The comprehension gap is real, and it's measured

The first systematic survey of vibe coding (Ge et al., 2025, arXiv:2510.12399) defines the practice as developers validating AI-generated implementations "through outcome observation rather than line-by-line code comprehension" — and reports unexpected productivity *losses* alongside the speed gains. The survey's central finding is that successful vibe coding depends less on agent capability and more on systematic context engineering and well-designed human–agent collaboration models.

That finding motivates Rocky's longer arc, but it does not establish Rocky's effect. The planned v0.5 dictionary is designed to help close the comprehension loop by connecting a user's recorded intent to the mechanism in their own work. v0.3.0 does not implement that dictionary, agent-change capture, ambiguity handling, digest, quiz, or proactive questions; today it provides terminal failure/fix memory, `rocky watch`, read-only MCP, and optional local interpretation of recall evidence.

### 2. Developers pay a recurring "re-finding tax"

A log study at Google (Sadowski, Stolee & Elbaum, FSE 2015) found that programmers run about five code-search sessions with 12 queries in a single workday. Follow-up work on web search in software engineering (Xia et al., Empirical Software Engineering 2017) found that debugging-related lookups are among the most frequent and most difficult search tasks developers face. A large-scale analysis of search-engine logs (Bansal et al., 2020, arXiv:2006.00385) confirmed exception debugging as one of the top reasons developers turn to the web at all.

In other words: a meaningful share of daily engineering time is spent *re-finding* information — often information the developer already had once. Human memory drops it; nothing in the toolchain catches it.

`rocky run` and `rocky recall` are built for exactly this gap. Eridians have photographic memory; Rocky records error → resolution pairs as they happen, so the second time an error appears, the answer comes from your own history in milliseconds instead of from a search engine in minutes. The core CLI stores that memory in a user-controlled JSONL file and sends no telemetry. The memory, hook, recall, and MCP paths reach no external host. The project's one piece of external egress lives elsewhere: the consent-gated package-existence lookup `rocky check` performs against the npm registry. Rocky's read-only MCP server sanitizes projected records by default; a configured host governs whether selected projected content is forwarded under its own policy.

### 3. Explaining beats being told: the planned v0.5 learning mechanism

Two robust findings from cognitive psychology shape Rocky's interaction design:

- **The self-explanation effect** (Chi, de Leeuw, Chiu & LaVancher, *Cognitive Science*, 1994): learners who generate explanations of material understand it measurably better than learners who only read it — even when the explanations are prompted.
- **The testing effect / retrieval practice** (Roediger & Karpicke, *Psychological Science*, 2006): retrieving knowledge produces stronger long-term retention than repeated passive review.

Teaching modes already exist inside individual agents. Rocky's planned v0.5 Intent↔Mechanism Dictionary takes a different, longitudinal approach: it uses material from the user's own work to expose the translation between a recorded intent and a concrete change. The material matters as much as the direction: what Rocky would ask about comes from the user's own commits and own prompts rather than from a generic exercise, which is the condition the self-explanation literature above studies. That design is consistent with self-explanation and retrieval-practice principles, but Rocky's learning effect has not been established. Rocky's asking and follow-up behavior is also planned v0.5 work, not current v0.3.0 behavior.

### 4. Where automated diagnosis fits (and its known limits)

When Rocky offers optional interpretation during `rocky recall --ai`, and when `rocky watch` keeps a failing run's stderr tail for later reading, the design follows what the automated-debugging literature has established:

- LLM debugging works better with step-by-step runtime information than with whole files dumped into a prompt (Zhong et al., 2024, arXiv:2402.16906 — up to 9.8% repair improvement).
- Single-shot LLM repair struggles with fault localization and broader project context; structured, multi-stage approaches do better (Lee et al., 2024, arXiv:2404.17153, published as *UniDebugger*).
- Integrating runtime tooling directly into the agent loop, rather than bolting it on, raised fix rates by over 20% for some models (Garg & Huang, Microsoft Research, 2026, arXiv:2602.18571).

This is why current Rocky records explicit commands, stderr, exit codes, fingerprints, and fix links at the moment of failure instead of asking a model to reason from an ungrounded prompt. Capturing agent diffs belongs to the planned v0.5 Nervous System, not v0.3.0.

### 5. Code nobody understands has a measured price

Comprehension debt is not only an aesthetic complaint; it shows up in the shape of the code being committed.

GitClear's 2025 report found the share of changed lines associated with refactoring falling from 25% in 2021 to under 10% in 2024, while copy/pasted lines rose from 8.3% to 12.3% — making 2024 the first year on record in which copy/pasted lines outnumbered moved (refactored) ones. Its 2026 follow-up reports the trend continuing: duplicated code blocks up 81% (40.3 → 73.0 per million changed lines, 2023 → 2026 year-to-date), constructs that mask errors rather than handle them up 47%, moved code down from 21% of changed lines in 2022 to 3.8% in 2026 year-to-date, and "long-term update percent" — changes touching code last modified more than twelve months earlier — down 74% since 2023 (1.7% → 0.46%).

Two limits on how far that evidence reaches. These are measurements of code, not of comprehension. And the reports do not break the debt down by developer cohort, so no claim that it concentrates among any particular group of developers is made here.

What the numbers do support is that the bill for code nobody re-reads is real and rising, and it is paid in agent runs spent on ambiguous direction, in debugging time on code that was never read, and in maintenance of duplicated blocks. Rocky is *built to* attack that cost. That is stated design intent for planned work: this document publishes no saving percentage, and the effect of Rocky's own approach remains a hypothesis for dogfooding and user research to test.

### 6. Corrections that do not persist: the amnesia loop

Anthropic's guidance for long-running agentic work states the problem plainly: a progress file should record failed approaches, because "the failed approaches are important—without them, successive sessions will re-attempt the same dead ends" (*Long-running Claude for scientific computing*, 2026).

The structural point is what the planned memory circuit breaker rests on: an agent inside a single iteration starts from a fresh context and therefore cannot, by construction, observe its own repetition. That pattern is visible only to an observer that lives across iterations and sessions. Loop detection that works per run loses its memory when the run ends; the contribution claimed here is persistence across time plus a human-readable account of it, and nothing more — measurable behavioural symptoms only (a repeated failure fingerprint, the same file rewritten N times), never the semantic quality of an outcome, for which Rocky has no ground truth. Negative knowledge, the circuit breaker, and every hook that would feed them are planned v0.5 work, not v0.3.0 behavior.

### 7. Automation-bias evidence is motivation, not proof

Human-factors research on automation bias and complacency is consistent with the risk that people may monitor automated support less carefully or accept its recommendations too readily. An experimental study of automation bias/complacency and a systematic review of automation bias in decision-support systems support that bounded motivation. They do not prove Rocky's entire proposed doom loop, and they do not prove that Rocky improves understanding. The Good Trade remains a v0.5 product hypothesis to validate through dogfooding and user research.

### References

1. Ge, Y. et al. (2025). *A Survey of Vibe Coding with Large Language Models.* arXiv:2510.12399.
2. Sadowski, C., Stolee, K. & Elbaum, S. (2015). *How Developers Search for Code: A Case Study.* ESEC/FSE 2015.
3. Xia, X. et al. (2017). *What Do Developers Search for on the Web?* Empirical Software Engineering, 22(6).
4. Bansal, C. et al. (2020). *An Empirical Study of Software Exceptions in the Field using Search Logs.* arXiv:2006.00385.
5. Chi, M.T.H., de Leeuw, N., Chiu, M-H. & LaVancher, C. (1994). *Eliciting Self-Explanations Improves Understanding.* Cognitive Science, 18(3).
6. Roediger, H.L. & Karpicke, J.D. (2006). *Test-Enhanced Learning: Taking Memory Tests Improves Long-Term Retention.* Psychological Science, 17(3).
7. Zhong, L. et al. (2024). *Debug like a Human: A Large Language Model Debugger via Verifying Runtime Execution Step-by-step.* arXiv:2402.16906.
8. Lee, C. et al. (2024). *UniDebugger: Hierarchical Multi-Agent Framework for Unified Software Debugging.* arXiv:2404.17153.
9. Garg, S. & Huang, Y. (2026). *Debug2Fix: Supercharging Coding Agents with Interactive Debugging Capabilities.* arXiv:2602.18571.
10. GitClear (2025). *AI Copilot Code Quality: 2025 Data Suggests 4x Growth in Code Clones.*
11. GitClear (2026). *The Maintainability Gap: 2026 AI Code Quality Research.*
12. Anthropic (2026). *Long-running Claude for scientific computing.* Published 23 March 2026.
10. Experimental study of automation bias and complacency. PubMed PMID 25886768. https://pubmed.ncbi.nlm.nih.gov/25886768/
11. Systematic review of automation bias in decision-support systems. PMC7651899. https://pmc.ncbi.nlm.nih.gov/articles/PMC7651899/

---

*rocky is an unofficial fan project inspired by the character Rocky from Andy Weir's novel* Project Hail Mary. *It is not affiliated with Andy Weir, Ballantine Books, or Amazon MGM Studios. No assets from the book or film are used.*
