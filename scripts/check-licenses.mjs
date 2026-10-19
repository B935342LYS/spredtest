/** 배포 의존성·버전·고지 원문을 대조하고 누락 시 빌드를 중단한다. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

/** UTF-8 파일을 LF로 정규화한다.
 * - 인수 : path : 프로젝트 기준 경로
 * - 반환값 : 정규화한 문자열
 */
function read(path) { return readFileSync(path, "utf8").replaceAll("\r\n", "\n"); }
/** JSON 파일을 읽는다.
 * - 인수 : path : 프로젝트 기준 경로
 * - 반환값 : JSON 값
 */
function json(path) { return JSON.parse(read(path)); }
/** 고지 원문을 HTML 본문 표현으로 변환한다.
 * - 인수 : text : 원문
 * - 반환값 : HTML 특수 문자를 변환한 문자열
 */
function escapeHtml(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#x27;");
}
const inventory = json("scripts/license-inventory.json");
const known = new Map();
for (const entry of inventory) {
  assert(!known.has(entry.name), `Duplicate inventory: ${entry.name}`);
  known.set(entry.name, entry);
}
const lock = json("package-lock.json");
assert.deepEqual(json("package.json").dependencies, lock.packages[""].dependencies, "package/lock dependencies differ");
// 전이 의존성까지 검사하고 개발 전용 패키지는 실제 번들 검사로 보완한다.
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path || entry.dev) continue;
  const name = path.split("node_modules/").at(-1);
  const notice = known.get(name);
  assert(notice, `Missing license inventory: ${name}`);
  assert.equal(entry.version, notice.version, `Review updated dependency: ${name}`);
  assert.equal(entry.license, notice.license, `Review changed license: ${name}`);
}
const html = read("public/licenses/index.html");
const notices = read("public/licenses/THIRD-PARTY-NOTICES.txt");
for (const entry of inventory) {
  const installed = json(`node_modules/${entry.name}/package.json`);
  assert.equal(installed.version, entry.version, `Installed version changed: ${entry.name}`);
  assert.equal(lock.packages[`node_modules/${entry.name}`].version, entry.version, `Lock version changed: ${entry.name}`);
  assert.equal(installed.license, entry.license, `Installed license changed: ${entry.name}`);
  let source = read(`node_modules/${entry.name}/${entry.file}`);
  if (entry.start) { assert(source.includes(entry.start)); source = source.split(entry.start)[1]; }
  if (entry.end) { assert(source.includes(entry.end)); source = source.split(entry.end)[0]; }
  source = source.trim();
  assert.equal(createHash("sha256").update(source).digest("hex"), entry.sha256, `License text changed: ${entry.name}`);
  assert(html.includes(escapeHtml(source)), `HTML notice missing: ${entry.name}`);
  assert(notices.includes(source), `Download notice missing: ${entry.name}`);
  assert(html.includes(entry.version), `Displayed version missing: ${entry.name}`);
}
// 실제 번들에 새 패키지가 포함되거나 고지 파일이 배포에서 빠지면 실패한다.
if (process.argv.includes("--bundle")) {
  const matches = [...read("dist/licenses/bundled-dependencies.md").matchAll(/^## (.+) - (.+) \((.+)\)$/gm)];
  assert(matches.length > 0, "Bundle inventory empty or format changed");
  for (const [, name, version, license] of matches) {
    const notice = known.get(name);
    assert(notice, `Undocumented bundled dependency: ${name}`);
    assert.equal(version, notice.version, `Bundled version changed: ${name}`);
    assert.equal(license, notice.license, `Bundled license changed: ${name}`);
  }
  for (const file of ["index.html", "licenses.css", "THIRD-PARTY-NOTICES.txt"]) {
    assert.equal(read(`dist/licenses/${file}`), read(`public/licenses/${file}`), `Published notice differs: ${file}`);
  }
}
console.log("License inventory, versions and complete notices verified.");
