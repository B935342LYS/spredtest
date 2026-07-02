/**
 * Edge Function manifest 응답을 앱 내부 Example manifest 타입으로 검증하고 정규화한다.
 */

import type {
  ExampleDifficulty,
  ExampleScoreManifest,
  ExampleScoreManifestItem,
  ExampleTrackId,
} from "./example_types";

const TRACK_ORDER: ExampleTrackId[] = ["basic", "optional", "extra"];
const TRACK_SET = new Set<string>(TRACK_ORDER);

/** manifest 검증 실패 정보. */
export type ExampleManifestValidationError = {
  code: "invalid_manifest";
  message: string;
  path: string;
};

/** manifest 검증 결과. */
export type ExampleManifestValidationResult =
  | {
      ok: true;
      manifest: ExampleScoreManifest;
    }
  | {
      ok: false;
      error: ExampleManifestValidationError;
    };

/**
 * unknown 값을 ExampleScoreManifest로 검증하고 optional field를 생략 형태로 정규화한다.
 * - 인수 : value : Edge Function 응답 JSON 값
 * - 반환값 : 검증된 manifest 또는 오류 정보
 */
export function validateExampleManifest(value: unknown): ExampleManifestValidationResult {
  if (!isRecord(value)) {
    return invalidManifest("", "Example manifest root must be an object.");
  }

  if (value.version !== 1) {
    return invalidManifest("version", "Example manifest version must be 1.");
  }

  const generatedAtResult = normalizeOptionalDate(value.generatedAt, "generatedAt");
  if (!generatedAtResult.ok) {
    return generatedAtResult;
  }

  if (!Array.isArray(value.examples)) {
    return invalidManifest("examples", "Example manifest examples must be an array.");
  }

  const examples: ExampleScoreManifestItem[] = [];
  const seenIds = new Set<string>();

  for (const [index, item] of value.examples.entries()) {
    const itemResult = normalizeManifestItem(item, `examples[${index}]`);

    if (!itemResult.ok) {
      return itemResult;
    }

    if (seenIds.has(itemResult.item.id)) {
      return invalidManifest(`examples[${index}].id`, `Duplicate example id: ${itemResult.item.id}.`);
    }

    seenIds.add(itemResult.item.id);
    examples.push(itemResult.item);
  }

  return {
    ok: true,
    manifest: {
      version: 1,
      ...(generatedAtResult.value === undefined ? {} : { generatedAt: generatedAtResult.value }),
      examples,
    },
  };
}

/**
 * 단일 manifest item을 검증하고 앱 내부 표시용 값으로 정규화한다.
 * - 인수 : value : manifest item 후보 값
 * - 인수 : path : 오류 표시용 JSON path
 * - 반환값 : 검증된 item 또는 오류 정보
 */
function normalizeManifestItem(
  value: unknown,
  path: string,
):
  | { ok: true; item: ExampleScoreManifestItem }
  | { ok: false; error: ExampleManifestValidationError } {
  if (!isRecord(value)) {
    return invalidManifest(path, "Example manifest item must be an object.");
  }

  const id = normalizeRequiredString(value.id, `${path}.id`);
  if (!id.ok) return id;

  const title = normalizeRequiredString(value.title, `${path}.title`);
  if (!title.ok) return title;

  const artist = normalizeRequiredString(value.artist, `${path}.artist`);
  if (!artist.ok) return artist;

  const tracks = normalizeSupportedTracks(value.supportedTracks, `${path}.supportedTracks`);
  if (!tracks.ok) return tracks;

  const scoreUrl = normalizeHttpsUrl(value.scoreUrl, `${path}.scoreUrl`);
  if (!scoreUrl.ok) return scoreUrl;

  const difficulty = normalizeDifficulty(value.difficulty, `${path}.difficulty`);
  if (!difficulty.ok) return difficulty;

  const durationSeconds = normalizeOptionalPositiveInteger(value.durationSeconds, `${path}.durationSeconds`);
  if (!durationSeconds.ok) return durationSeconds;

  const sizeBytes = normalizeOptionalPositiveInteger(value.sizeBytes, `${path}.sizeBytes`);
  if (!sizeBytes.ok) return sizeBytes;

  const createdAt = normalizeOptionalDate(value.createdAt, `${path}.createdAt`);
  if (!createdAt.ok) return createdAt;

  const updatedAt = normalizeOptionalDate(value.updatedAt, `${path}.updatedAt`);
  if (!updatedAt.ok) return updatedAt;

  return {
    ok: true,
    item: {
      id: id.value,
      title: title.value,
      artist: artist.value,
      ...(difficulty.value === undefined ? {} : { difficulty: difficulty.value }),
      supportedTracks: tracks.value,
      ...(durationSeconds.value === undefined ? {} : { durationSeconds: durationSeconds.value }),
      ...(sizeBytes.value === undefined ? {} : { sizeBytes: sizeBytes.value }),
      scoreUrl: scoreUrl.value,
      ...(createdAt.value === undefined ? {} : { createdAt: createdAt.value }),
      ...(updatedAt.value === undefined ? {} : { updatedAt: updatedAt.value }),
    },
  };
}

/**
 * required string 값을 trim한 뒤 빈 문자열 여부를 확인한다.
 * - 인수 : value : 검사할 값
 * - 인수 : path : 오류 표시용 JSON path
 * - 반환값 : trim된 문자열 또는 오류 정보
 */
function normalizeRequiredString(
  value: unknown,
  path: string,
):
  | { ok: true; value: string }
  | { ok: false; error: ExampleManifestValidationError } {
  if (typeof value !== "string") {
    return invalidManifest(path, "Value must be a string.");
  }

  const text = value.trim();

  if (text.length === 0) {
    return invalidManifest(path, "Value must not be blank.");
  }

  return { ok: true, value: text };
}

/**
 * HTTPS URL 문자열을 검증한다.
 * - 인수 : value : 검사할 값
 * - 인수 : path : 오류 표시용 JSON path
 * - 반환값 : trim된 HTTPS URL 또는 오류 정보
 */
function normalizeHttpsUrl(
  value: unknown,
  path: string,
):
  | { ok: true; value: string }
  | { ok: false; error: ExampleManifestValidationError } {
  const text = normalizeRequiredString(value, path);

  if (!text.ok) {
    return text;
  }

  try {
    const url = new URL(text.value);

    if (url.protocol !== "https:") {
      return invalidManifest(path, "URL must use HTTPS.");
    }
  } catch {
    return invalidManifest(path, "Value must be a valid URL.");
  }

  return text;
}

/**
 * supportedTracks 배열을 허용 track 순서로 정렬된 중복 없는 배열로 검증한다.
 * - 인수 : value : 검사할 값
 * - 인수 : path : 오류 표시용 JSON path
 * - 반환값 : 정규화된 track id 배열 또는 오류 정보
 */
function normalizeSupportedTracks(
  value: unknown,
  path: string,
):
  | { ok: true; value: ExampleTrackId[] }
  | { ok: false; error: ExampleManifestValidationError } {
  if (!Array.isArray(value)) {
    return invalidManifest(path, "supportedTracks must be an array.");
  }

  if (value.length === 0) {
    return invalidManifest(path, "supportedTracks must contain at least one track.");
  }

  const seen = new Set<ExampleTrackId>();

  for (const [index, track] of value.entries()) {
    if (typeof track !== "string" || !TRACK_SET.has(track)) {
      return invalidManifest(`${path}[${index}]`, "Unsupported track id.");
    }

    const trackId = track as ExampleTrackId;

    if (seen.has(trackId)) {
      return invalidManifest(`${path}[${index}]`, `Duplicate track id: ${trackId}.`);
    }

    seen.add(trackId);
  }

  return {
    ok: true,
    value: TRACK_ORDER.filter((track) => seen.has(track)),
  };
}

/**
 * optional difficulty 객체를 finite number 범위로 검증한다.
 * - 인수 : value : 검사할 값
 * - 인수 : path : 오류 표시용 JSON path
 * - 반환값 : 난이도 객체, undefined, 또는 오류 정보
 */
function normalizeDifficulty(
  value: unknown,
  path: string,
):
  | { ok: true; value: ExampleDifficulty | undefined }
  | { ok: false; error: ExampleManifestValidationError } {
  if (value === undefined || value === null) {
    return { ok: true, value: undefined };
  }

  if (!isRecord(value)) {
    return invalidManifest(path, "difficulty must be an object.");
  }

  const difficulty: ExampleDifficulty = {};

  for (const track of TRACK_ORDER) {
    const normalized = normalizeOptionalDifficultyNumber(value[track], `${path}.${track}`);

    if (!normalized.ok) {
      return normalized;
    }

    if (normalized.value !== undefined) {
      difficulty[track] = normalized.value;
    }
  }

  return {
    ok: true,
    value: Object.keys(difficulty).length === 0 ? undefined : difficulty,
  };
}

/**
 * optional difficulty number를 0 초과 99 이하로 검증한다.
 * - 인수 : value : 검사할 값
 * - 인수 : path : 오류 표시용 JSON path
 * - 반환값 : number, undefined, 또는 오류 정보
 */
function normalizeOptionalDifficultyNumber(
  value: unknown,
  path: string,
):
  | { ok: true; value: number | undefined }
  | { ok: false; error: ExampleManifestValidationError } {
  if (value === undefined || value === null) {
    return { ok: true, value: undefined };
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 99) {
    return invalidManifest(path, "difficulty value must be a finite number greater than 0 and less than or equal to 99.");
  }

  return { ok: true, value };
}

/**
 * optional positive integer 값을 검증한다.
 * - 인수 : value : 검사할 값
 * - 인수 : path : 오류 표시용 JSON path
 * - 반환값 : 정수, undefined, 또는 오류 정보
 */
function normalizeOptionalPositiveInteger(
  value: unknown,
  path: string,
):
  | { ok: true; value: number | undefined }
  | { ok: false; error: ExampleManifestValidationError } {
  if (value === undefined || value === null) {
    return { ok: true, value: undefined };
  }

  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    return invalidManifest(path, "Value must be a positive integer.");
  }

  return { ok: true, value };
}

/**
 * optional date string을 Date.parse 가능한 문자열로 검증한다.
 * - 인수 : value : 검사할 값
 * - 인수 : path : 오류 표시용 JSON path
 * - 반환값 : trim된 날짜 문자열, undefined, 또는 오류 정보
 */
function normalizeOptionalDate(
  value: unknown,
  path: string,
):
  | { ok: true; value: string | undefined }
  | { ok: false; error: ExampleManifestValidationError } {
  if (value === undefined || value === null) {
    return { ok: true, value: undefined };
  }

  const text = normalizeRequiredString(value, path);

  if (!text.ok) {
    return text;
  }

  if (Number.isNaN(Date.parse(text.value))) {
    return invalidManifest(path, "Date value must be parseable.");
  }

  return text;
}

/**
 * 객체 record 여부를 확인한다.
 * - 인수 : value : 검사할 값
 * - 반환값 : 일반 object이면 true
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * manifest 검증 오류를 만든다.
 * - 인수 : path : 오류 위치
 * - 인수 : message : 오류 설명
 * - 반환값 : 실패 결과
 */
function invalidManifest(
  path: string,
  message: string,
): { ok: false; error: ExampleManifestValidationError } {
  return {
    ok: false,
    error: {
      code: "invalid_manifest",
      message,
      path,
    },
  };
}
