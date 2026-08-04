/**
 * `rocky recall "<query>"`
 *
 * Ask Rocky's memory directly. Fuzzy-matches the query against every
 * remembered failure (command + error signature) and shows the best hits
 * with their fixes, newest context first.
 */

import { loadMemory } from "../core/memory.js";
import { queryRecall } from "../core/memory-query.js";
import { ago, detail, heading, say } from "../ui/rocky.js";

export function recall(query: string): number {
  if (!query || query.trim().length === 0) {
    say("recall what, question. give words from error.");
    return 2;
  }

  const memory = loadMemory();
  if (memory.length === 0) {
    say("memory is empty. no errors yet. this is good... or you not use me yet, question");
    return 0;
  }

  const hits = queryRecall(memory, { query });
  if (hits.length === 0) {
    say("I listen to memory. nothing match. maybe error is new, maybe words are different.");
    return 1;
  }

  say(`I remember ${hits.length} thing${hits.length === 1 ? "" : "s"}.`);
  for (const [i, hit] of hits.entries()) {
    heading(`${i + 1}. ${hit.failure.cmd}   (${ago(hit.failure.ts)}, exit ${hit.failure.exitCode})`);
    detail(indent(hit.failure.excerpt));
    if (hit.fix) {
      say(`fixed with: ${hit.fix.cmd}`);
    } else {
      say("no fix recorded for this one. bad bad.");
    }
  }
  return 0;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => "    " + l)
    .join("\n");
}
