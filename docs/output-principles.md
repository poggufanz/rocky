# Output principles

These rules govern what rocky is allowed to say and do. They exist because a memory tool that starts guessing stops being evidence, and a tool that talks constantly stops being read.

Every new command, surface, or output line passes these tests before it ships.

## 1. Witness, not judge

rocky learns a thing by recording it as it happens and checking the record later. It never infers, predicts, or diagnoses.

A surface passes if every claim it makes traces back to a recorded event. It fails if it produces a conclusion no record supports: a likely cause, a probable culprit, an inferred intent. When the record is silent, the honest output says that nothing was recorded.

rocky is not the one who diagnoses a failure, proposes a fix, or decides whether a change is correct. An AI agent does that. rocky supplies the memory that makes the agent's judgment better informed, and keeps the human able to answer for what the agent built. It may surface what it recorded when a fingerprint matches. It may not suggest anything it did not record, because a suggestion beyond the record is a guess presented as evidence.

## 2. Evidence, never assertion

Confidence is earned by producing the record, not by sounding certain. This is why a linked fix is `confirmed` only when the evidence justifies that word and stays `possible` otherwise, why a bounded read discloses that it was bounded, and why memory coverage is reported rather than assumed complete.

A surface passes if a user can ask "how do you know" and get the underlying record. It fails if it asks to be believed. Scope lines stay honest and specific: `checked net change: 4 new text lines, 2 files. no secret hit.` says what was checked, not that everything is fine.

## 3. Quiet by default

rocky stays quiet through ordinary work and speaks when something it recorded bears on what is happening now. Every message competes with the user's attention.

A surface passes if it stays quiet by default and has a specific trigger worth interrupting for. It fails if it fires on a schedule, greets, or reminds the user it exists. `rocky watch --quiet` stays quieter still.

## 4. Plain words

Output is plain, neutral English, the way other command-line tools write.

- rocky-owned lines on stderr start with `rocky: ` (lowercase, one prefix everywhere). Detail lines below them are indented or dimmed without a prefix.
- Full sentences in sentence case, ending with a period: `rocky: New error recorded (exit code 1).`
- Questions end with a question mark. Prompts that take an answer show the choices: `Allow registry lookup? [y/N]`.
- No first person. rocky reports what was recorded, checked, or linked: `Same error as before. No fix recorded yet.`
- No emphasis by repetition and no verdict tags such as a trailing `good.` or `bad.`. State the fact; the exit code carries success or failure.
- Name exact commands, paths, counts, and flags. A blocked action names the command that unblocks it.
- No emoji, no mascot, no drawings made of characters.

The phrase catalog in `src/ui/phrases.ts` and its validator (`validateOutputLine`) enforce the mechanical part of these rules in tests.
