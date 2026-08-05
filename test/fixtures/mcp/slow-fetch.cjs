"use strict";

globalThis.fetch = async (url, init = {}) => {
  const path = new URL(String(url)).pathname;
  if (path === "/api/tags") {
    return new Response(JSON.stringify({ models: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (path !== "/api/generate") throw new Error(`unexpected local AI request: ${path}`);

  process.stderr.write(`SLOW_FETCH_PROMPT_BASE64 ${Buffer.from(String(init.body ?? ""), "utf8").toString("base64")}\n`);
  return await new Promise((resolve, reject) => {
    const signal = init.signal;
    const abort = () => reject(signal?.reason ?? new Error("local AI request cancelled"));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
};
