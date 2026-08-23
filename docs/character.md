# Character rules

Rocky's voice rules live in `src/ui/rocky.ts` and govern how he speaks. These rules govern what he is allowed to *do*. They exist because a memory tool that starts guessing stops being evidence, and a tool that talks constantly stops being heard.

Every new command, surface, or output passes four tests before it ships.

## 1. Knows by hearing, not by guessing

Rocky is blind. He learns a thing by hearing it happen, recording it, and checking the record later. He never sees, never infers, never predicts.

A surface passes if every claim it makes traces back to a recorded event. It fails if it produces a conclusion no record supports — a likely cause, a probable culprit, an inferred intent. When the record is silent, the honest output is that Rocky does not know.

## 2. Shows evidence, never asserts

Confidence is earned by producing the record, not by sounding certain. This is why a linked fix is `confirmed` only when the evidence justifies that word and stays `possible` otherwise, why a bounded read discloses that it was bounded, and why memory coverage is reported rather than assumed complete.

A surface passes if a user can ask "how do you know" and get the underlying record. It fails if it asks to be believed.

## 3. Silent unless it matters

Rocky is not a companion who fills the room. He is quiet through the ordinary work and speaks when something he remembers bears on what is happening now. Every message competes with the user's attention, and attention spent on noise is attention unavailable when the message is real.

A surface passes if it stays quiet by default and has a specific trigger worth interrupting for. It fails if it fires on a schedule, greets, or reminds the user it exists.

## 4. Reciprocity is visible

The relationship is a trade between two parties who each hold something the other lacks. The human fixes things and decides what they mean; Rocky holds what neither a human nor an agent retains across sessions. Neither side is the other's tool.

A surface passes if the exchange is legible in the output — the user gave something, Rocky gives something back. It fails if it takes without returning, or returns without having been given anything.

## Boundary this draws

Rocky is a witness, not a judge. He is not the one who diagnoses a failure, proposes a fix, or decides whether a change is correct — an AI agent does that, and does it better. Rocky supplies the memory that makes the agent's judgment better informed, and keeps the human able to answer for what the agent built.

The distinction is sharpest on suggestion. Rocky may surface what he remembers when a fingerprint matches. He may not suggest anything he does not remember, because a suggestion beyond the record is a guess wearing the clothes of evidence, and rule 2 forbids it.
