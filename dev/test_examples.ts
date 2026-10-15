import assert from "node:assert/strict";

import { validateExampleManifest } from "../src/app/examples/example_manifest_validate";

const validManifest = {
  version: 1,
  generatedAt: "2026-07-02T00:00:00.000Z",
  examples: [
    {
      id: "sample-score",
      title: "Sample Score",
      artist: "Tester",
      genre: "Test Genre",
      difficulty: {
        basic: 1.5,
        optional: 2,
      },
      supportedTracks: ["optional", "basic"],
      durationSeconds: 123,
      sizeBytes: 2048,
      scoreUrl: "https://example.com/sample-score.json",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-02T00:00:00.000Z",
    },
  ],
};

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function expectInvalid(value: unknown, path: string): void {
  const result = validateExampleManifest(value);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.path, path);
  }
}

const validResult = validateExampleManifest(validManifest);
assert.equal(validResult.ok, true);

if (validResult.ok) {
  assert.deepEqual(validResult.manifest.examples[0]?.supportedTracks, ["basic", "optional"]);
  assert.equal(validResult.manifest.examples[0]?.difficulty?.basic, 1.5);
  assert.equal(validResult.manifest.examples[0]?.genre, "Test Genre");
}

const duplicateTrack = cloneJson(validManifest);
duplicateTrack.examples[0].supportedTracks = ["basic", "basic"];
expectInvalid(duplicateTrack, "examples[0].supportedTracks[1]");

const nonHttpsUrl = cloneJson(validManifest);
nonHttpsUrl.examples[0].scoreUrl = "http://example.com/sample-score.json";
expectInvalid(nonHttpsUrl, "examples[0].scoreUrl");

const tooLargeDifficulty = cloneJson(validManifest);
tooLargeDifficulty.examples[0].difficulty.basic = 100;
expectInvalid(tooLargeDifficulty, "examples[0].difficulty.basic");

const blankGenre = cloneJson(validManifest);
blankGenre.examples[0].genre = " ";
expectInvalid(blankGenre, "examples[0].genre");

const badGeneratedAt = cloneJson(validManifest);
badGeneratedAt.generatedAt = "not a date";
expectInvalid(badGeneratedAt, "generatedAt");

const duplicateId = cloneJson(validManifest);
duplicateId.examples.push(cloneJson(validManifest).examples[0]);
expectInvalid(duplicateId, "examples[1].id");

console.log("test_examples passed");
