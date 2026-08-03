## Scientific grounding

> *"You forget. I remember. This is good trade."* — Rocky, probably

Rocky is not a debugging agent. Plenty of tools already write and fix code for you. Rocky exists because of what those tools leave behind: developers who ship code they don't fully understand, and who solve the same problem twice because the first solution never made it into memory. Both problems are documented in the research below.

### 1. The comprehension gap is real, and it's measured

The first systematic survey of vibe coding (Ge et al., 2025, arXiv:2510.12399) defines the practice as developers validating AI-generated implementations "through outcome observation rather than line-by-line code comprehension" — and reports unexpected productivity *losses* alongside the speed gains. The survey's central finding: successful vibe coding depends less on agent capability and more on systematic context engineering and well-designed human–agent collaboration models.

Rocky is built directly on that finding. `rocky explain` closes the comprehension loop by making you articulate what the AI built (see §3), and every Rocky feature is a context-engineering layer: it gathers terminal history, git diffs, and error output locally so that neither you nor your LLM works from a bare stack trace.

### 2. Developers pay a recurring "re-finding tax"

A log study at Google (Sadowski, Stolee & Elbaum, FSE 2015) found that programmers run about five code-search sessions with 12 queries in a single workday. Follow-up work on web search in software engineering (Xia et al., Empirical Software Engineering 2017) found that debugging-related lookups are among the most frequent and most difficult search tasks developers face. A large-scale analysis of search-engine logs (Bansal et al., 2020, arXiv:2006.00385) confirmed exception debugging as one of the top reasons developers turn to the web at all.

In other words: a meaningful share of daily engineering time is spent *re-finding* information — often information the developer already had once. Human memory drops it; nothing in the toolchain catches it.

`rocky remember` is built for exactly this gap. Eridians have photographic memory; Rocky records error → resolution pairs locally as they happen, so the second time an error appears, the answer comes from your own history in milliseconds instead of from a search engine in minutes. No cloud, no telemetry — the memory lives on your machine.

### 3. Explaining beats being told: the learning science behind `rocky explain`

Two robust findings from cognitive psychology shape Rocky's interaction design:

- **The self-explanation effect** (Chi, de Leeuw, Chiu & LaVancher, *Cognitive Science*, 1994): learners who generate explanations of material understand it measurably better than learners who only read it — even when the explanations are prompted.
- **The testing effect / retrieval practice** (Roediger & Karpicke, *Psychological Science*, 2006): retrieving knowledge produces stronger long-term retention than repeated passive review.

Most AI tools explain code *to* you — passive review, the weak condition in both studies. Rocky inverts it: he is blind, so *you* must explain the code to *him*, and he asks follow-up questions. The gimmick is the mechanism.

### 4. Where automated diagnosis fits (and its known limits)

When Rocky does offer a diagnosis (during `rocky remember` recall or `rocky watch` post-mortems), the design follows what the automated-debugging literature has established:

- LLM debugging works better with step-by-step runtime information than with whole files dumped into a prompt (Zhong et al., 2024, arXiv:2402.16906 — up to 9.8% repair improvement).
- Single-shot LLM repair struggles with fault localization and broader project context; structured, multi-stage approaches do better (Lee et al., 2024, arXiv:2404.17153, published as *UniDebugger*).
- Integrating runtime tooling directly into the agent loop, rather than bolting it on, raised fix rates by over 20% for some models (Garg & Huang, Microsoft Research, 2026, arXiv:2602.18571).

This is why Rocky gathers stderr, exit codes, and diffs at the moment of failure instead of asking an LLM to reason from a pasted log.

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

---

*rocky is an unofficial fan project inspired by the character Rocky from Andy Weir's novel* Project Hail Mary. *It is not affiliated with Andy Weir, Ballantine Books, or Amazon MGM Studios. No assets from the book or film are used.*
