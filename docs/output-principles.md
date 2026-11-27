# Output conventions

This page documents user-facing output: source labels, coverage disclosures, notifications, and CLI formatting. It does not prescribe the project's architecture or limit which features can be proposed.

## Sources and coverage

Keep recorded events, quoted rationale, deterministic analysis, and model-generated responses distinguishable. A quote records what an agent said, not proof that its explanation is correct. Generated analysis must not be presented as a recorded event or attributed quote.

Link claims about recorded history to their evidence. A linked fix is `confirmed` only when the recorded evidence supports that label; otherwise it stays `possible`. Disclose bounded reads and incomplete memory coverage. When a reason was not recorded, say so instead of filling the gap with invented testimony.

Scope lines name what was checked: `checked net change: 4 new text lines, 2 files. no secret hit.` is a bounded result, not a claim that everything is safe.

## Notifications and quiet mode

Document when a command or background feature produces output and how users control it. Keep existing quiet flags and notification settings working when changing a surface. Do not mix Rocky-owned messages into the stdout of a wrapped command.

## CLI formatting

Output uses plain, neutral English.

- rocky-owned lines on stderr start with `rocky: ` (lowercase, one prefix everywhere). Detail lines below them are indented or dimmed without a prefix.
- Full sentences in sentence case, ending with a period: `rocky: New error recorded (exit code 1).`
- Questions end with a question mark. Prompts that take an answer show the choices: `Allow registry lookup? [y/N]`.
- No first person. Report what was recorded, checked, or linked: `Same error as before. No fix recorded yet.`
- No emphasis by repetition and no verdict tags such as a trailing `good.` or `bad.`. State the result; the exit code carries success or failure.
- Name exact commands, paths, counts, and flags. A blocked action names the command that unblocks it.
- No emoji, mascot, or drawings made of characters.

The phrase catalog in `src/ui/phrases.ts` and its validator (`validateOutputLine`) check the mechanical formatting in tests.
