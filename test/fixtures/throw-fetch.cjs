"use strict";

const childProcess = require("node:child_process");
const { appendFileSync } = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");

function mark(environmentName, event) {
  const path = process.env[environmentName];
  if (path !== undefined) appendFileSync(path, `${event}\n`, "utf8");
}

globalThis.fetch = function rockyUnexpectedFetch() {
  mark("ROCKY_TEST_FETCH_MARKER", "fetch");
  throw new Error("unexpected fetch from isolated Rocky CLI process");
};

const originalSpawn = childProcess.spawn;
childProcess.spawn = function rockyObservedSpawn(command, args, options) {
  const spawnOptions = Array.isArray(args) ? options : args;
  if (spawnOptions?.detached === true) {
    mark("ROCKY_TEST_BACKGROUND_MARKER", "detached");
    throw new Error("detached child blocked in isolated Rocky CLI process");
  }
  return originalSpawn.apply(this, arguments);
};

const originalFork = childProcess.fork;
childProcess.fork = function rockyObservedFork(modulePath, args, options) {
  const forkOptions = Array.isArray(args) ? options : args;
  if (forkOptions?.detached === true) {
    mark("ROCKY_TEST_BACKGROUND_MARKER", "detached");
    throw new Error("detached child blocked in isolated Rocky CLI process");
  }
  return originalFork.apply(this, arguments);
};

childProcess.ChildProcess.prototype.unref = function rockyBlockedUnref() {
  mark("ROCKY_TEST_BACKGROUND_MARKER", "unref");
  throw new Error("child unref blocked in isolated Rocky CLI process");
};

syncBuiltinESMExports();
