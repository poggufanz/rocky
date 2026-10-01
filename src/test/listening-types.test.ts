import test from "node:test";
import assert from "node:assert/strict";
import {
  HARNESS_IDS,
  V1_LINK_BASES,
  assertV1Basis,
  isHarnessId,
  isV1LinkBasis,
  PROPOSAL_MAX_EVENT_STORE_BYTES_PER_REPO,
  PROPOSAL_MAX_FILE_VERSION_BYTES,
  PROPOSAL_MAX_OBJECT_STORE_BYTES_PER_REPO,
  PROPOSAL_MAX_PATHS_PER_RECONCILIATION,
} from "../listening/types.js";
import { consentsPath, eventsPath, repoSlug } from "../listening/store-paths.js";

test("v1 basis allowlist excludes runtime_observed and observer_hypothesis", () => {
  assert.equal(isV1LinkBasis("runtime_observed"), false);
  assert.equal(isV1LinkBasis("observer_hypothesis"), false);
  assert.equal(isV1LinkBasis("direct"), true);
  assert.equal(isV1LinkBasis("filesystem_observed"), true);
  assert.equal(isV1LinkBasis("content_mapped"), true);
  assert.equal(isV1LinkBasis("candidate_link"), true);
  assert.equal(isV1LinkBasis("temporal_candidate"), true);
  assert.equal(isV1LinkBasis("unknown"), true);
  assert.throws(() => assertV1Basis("runtime_observed"), /forbidden v1 link basis/);
  assert.throws(() => assertV1Basis("observer_hypothesis"), /forbidden v1 link basis/);
  assert.equal((V1_LINK_BASES as readonly string[]).length, 6);
});

test("registry holds exactly 11 closed harness ids", () => {
  assert.equal(HARNESS_IDS.length, 11);
  assert.equal(isHarnessId("claude-desktop"), false);
  assert.equal(isHarnessId("codex"), true);
});

test("bounds are PROPOSAL-named owner-approval values", () => {
  assert.equal(PROPOSAL_MAX_FILE_VERSION_BYTES, 1 * 1024 * 1024);
  assert.equal(PROPOSAL_MAX_PATHS_PER_RECONCILIATION, 10_000);
  assert.equal(PROPOSAL_MAX_OBJECT_STORE_BYTES_PER_REPO, 128 * 1024 * 1024);
  assert.equal(PROPOSAL_MAX_EVENT_STORE_BYTES_PER_REPO, 32 * 1024 * 1024);
});

test("store paths are deterministic and never embed the raw root", () => {
  assert.equal(repoSlug("/repo/a"), repoSlug("/repo/a"));
  assert.notEqual(repoSlug("/repo/a"), repoSlug("/repo/b"));
  assert.ok(!/[\/]/.test(repoSlug("/repo/a")));
  assert.ok(!eventsPath("/repo/a", process.cwd()).includes(repoSlug("/other")));
  assert.ok(consentsPath(process.cwd()).endsWith("repo-consents.json"));
});
