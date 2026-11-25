import assert from "node:assert/strict";
import test from "node:test";
import {
  BOOTSTRAP_RESAMPLES,
  BOOTSTRAP_SEED,
  Z90,
  clusterBootstrapDiff,
  mde,
  mulberry32,
  newcombeDiff,
  percentileNearestRank,
  wilson,
  type StudyCluster,
} from "../core/attempt-study-math.js";

const bootstrapOptions = {
  resamples: BOOTSTRAP_RESAMPLES,
  seed: BOOTSTRAP_SEED,
  level: 0.9,
};

const rankBoundaryClusters: readonly StudyCluster[] = [
  { arm: "shown", successes: 0, total: 1 },
  { arm: "shown", successes: 1, total: 1 },
  { arm: "held", successes: 0, total: 1 },
  { arm: "held", successes: 1, total: 1 },
];

test("Newcombe method 10 matches the worked example", () => {
  const result = newcombeDiff(56, 70, 48, 80, 1.959964);
  assert.ok(result);
  assert.ok(Math.abs(result.diff - 0.2) <= 5e-4);
  assert.ok(Math.abs(result.lower - 0.0524) <= 5e-4);
  assert.ok(Math.abs(result.upper - 0.3339) <= 5e-4);
});

test("Newcombe intervals require observations in both arms", () => {
  assert.equal(newcombeDiff(0, 0, 48, 80, Z90), undefined);
  assert.equal(newcombeDiff(56, 70, 0, 0, Z90), undefined);
});

test("Wilson limits stay within the probability bounds", () => {
  assert.equal(wilson(0, 10, Z90)[0], 0);
  assert.equal(wilson(10, 10, Z90)[1], 1);
  assert.deepEqual(wilson(0, 0, Z90), [0, 1]);
  for (let successes = 0; successes <= 10; successes++) {
    const [lower, upper] = wilson(successes, 10, Z90);
    assert.ok(0 <= lower && lower <= upper && upper <= 1);
  }
});

test("minimum detectable effect uses both sample sizes and the pooled rate", () => {
  const effect = mde(150, 150, 0.5);
  assert.equal(effect?.toFixed(3), "0.144");
  assert.equal(mde(0, 10, 0.5), undefined);
  assert.equal(mde(10, 0, 0.5), undefined);
});

test("Mulberry32 generates independent, repeatable sequences in [0, 1)", () => {
  const first = mulberry32(0x5eed11);
  const second = mulberry32(0x5eed11);
  const values = Array.from({ length: 5 }, first);
  assert.deepEqual(values, Array.from({ length: 5 }, second));
  assert.ok(values.every((value) => 0 <= value && value < 1));
});

test("cluster bootstrap is deterministic and pools counts within each arm", () => {
  const clusters: StudyCluster[] = [
    { arm: "shown", successes: 1, total: 1 },
    { arm: "shown", successes: 0, total: 3 },
    { arm: "held", successes: 1, total: 2 },
  ];
  const options = { ...bootstrapOptions, resamples: 2 };
  const interval = clusterBootstrapDiff(clusters, options);
  assert.deepEqual(interval, { lower: -0.25, upper: 0.5 });
  assert.deepEqual(clusterBootstrapDiff(clusters, options), interval);
});

test("cluster bootstrap uses index 100 for the lower bound of 2,000 replicates at 90%", () => {
  // This seed gives 100 differences of -1 followed by differences of -0.5.
  const options = { ...bootstrapOptions, seed: 464 };
  assert.deepEqual(clusterBootstrapDiff(rankBoundaryClusters, options), { lower: -0.5, upper: 1 });
  assert.deepEqual(
    clusterBootstrapDiff(rankBoundaryClusters, { ...options, level: 0.9000000000000001 }),
    { lower: -1, upper: 1 },
  );
});

test("cluster bootstrap preserves an integer upper rank", () => {
  // This seed puts 0 at index 13 and 0.5 at index 14.
  const options = { resamples: 25, seed: 46, level: 0.12 };
  assert.deepEqual(clusterBootstrapDiff(rankBoundaryClusters, options), { lower: 0, upper: 0 });
});

test("cluster bootstrap yields a point interval for uniform arm outcomes", () => {
  const clusters: StudyCluster[] = [
    { arm: "shown", successes: 1, total: 1 },
    { arm: "shown", successes: 1, total: 1 },
    { arm: "held", successes: 0, total: 1 },
    { arm: "held", successes: 0, total: 1 },
  ];
  assert.deepEqual(clusterBootstrapDiff(clusters, bootstrapOptions), { lower: 1, upper: 1 });
});

test("cluster bootstrap requires clusters in both arms", () => {
  assert.equal(clusterBootstrapDiff([{ arm: "shown", successes: 1, total: 1 }], bootstrapOptions), undefined);
  assert.equal(clusterBootstrapDiff([{ arm: "held", successes: 0, total: 1 }], bootstrapOptions), undefined);
});

test("cluster bootstrap omits replicates with an empty total", () => {
  const clusters: StudyCluster[] = [
    { arm: "shown", successes: 0, total: 0 },
    { arm: "shown", successes: 1, total: 1 },
    { arm: "held", successes: 1, total: 2 },
  ];
  const options = { ...bootstrapOptions, resamples: 2 };
  assert.deepEqual(clusterBootstrapDiff(clusters, options), { lower: 0.5, upper: 0.5 });
  assert.equal(clusterBootstrapDiff(clusters, { ...options, resamples: 1 }), undefined);
});

test("nearest-rank percentile sorts a copy and handles empty and singleton inputs", () => {
  const values = [5, 1, 3, 2, 4];
  assert.equal(percentileNearestRank(values, 0.95), 5);
  assert.deepEqual(values, [5, 1, 3, 2, 4]);
  assert.equal(percentileNearestRank([], 0.95), undefined);
  assert.equal(percentileNearestRank([7], 0.95), 7);
});
