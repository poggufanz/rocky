"use strict";

globalThis.fetch = function rockyUnexpectedFetch() {
  throw new Error("unexpected fetch from isolated Rocky CLI process");
};
