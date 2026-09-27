import { runJxa } from "run-jxa";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { execSync } from "node:child_process";
import TurndownService from "turndown";

// ---------------------------------------------------------------------------
// sermon-catalog.ts
//
// LanceDB 색인(검색용)과는 별개로, "제목에 설교/기도회 관련 표시가 있는
// 메모만" 골라서 날짜 · 예상 본문(성경 구절) · 분량을 정리한 목록을 만든다.
// 설교집 챕터 구성을 잡을 때, 실제로 어떤 본문/종류의 설교가 몇 편이나
// 있는지 눈으로 보기 위한 용도.
//
// 결과는 이 폴더에 sermon-catalog.json (전체 데이터)과
// sermon-catalog-summary.txt (요약)로 저장된다.
//
// 주의: 본문(body)까지 가져오는 건 느리다(메모당 수 초). 그래서 먼저
// "제목"만 가볍게 다 훑어서 후보를 추리고, 후보에 대해서만 본문을 가져온다.
// 후보가 많으면(예: 수년간 매일 새벽기도) 시간이 오래 걸릴 수 있으니,
// 중간에 죽어도 이어서 할 수 있게 진행 중 저장한다.
// ---------------------------------------------------------------------------

const PROJECT_DIR = path.dirname(new URL(import.meta.url).pathname);
const OUT_JSON = path.join(PROJECT_DIR, "sermon-catalog.json");
const OUT_SUMMARY = path.join(PROJECT_DIR, "sermon-catalog-summary.txt");

const { turndown } = new TurndownService();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 제목에 이 중 하나라도 포함되면 "설교/메시지 후보"로 본다.
const TITLE_KEYWORDS = [
  "주일설교",
  "수요설교",
  "금요설교",
  "새벽설교",
  "새벽기도",
  "특별새벽",
  "철야기도",
  "심야기도",
  "부흥회",
  "사경회",
  "강해설교",
  "설교",
  "경건회",
  "말씀",
];

// 성경책 이름/약자. 짝지은 약자는 뒤에 숫자(장/절)가 바로 따라올 때만
// 성경 구절로 인정한다(그냥 한글 단어와 헷갈리지 않도록).
const BOOKS: Array<[string, string]> = [
  ["창세기", "창"], ["출애굽기", "출"], ["레위기", "레"], ["민수기", "민"],
  ["신명기", "신"], ["여호수아", "수"], ["사사기", "삿"], ["룻기", "룻"],
  ["사무엘상", "삼상"], ["사무엘하", "삼하"], ["열왕기상", "왕상"], ["열왕기하", "왕하"],
  ["역대상", "대상"], ["역대하", "대하"], ["에스라", "스"], ["느헤미야", "느"],
  ["에스더", "에스"], ["욥기", "욥"], ["시편", "시"], ["잠언", "잠"],
  ["전도서", "전"], ["아가", "아"], ["이사야", "이사야"], ["예레미야", "렘"],
  ["예레미야애가", "애"], ["에스겔", "겔"], ["다니엘", "단"], ["호세아", "호"],
  ["요엘", "욜"], ["아모스", "암"], ["오바댜", "옵"], ["요나", "욘"],
  ["미가", "미"], ["나훔", "나"], ["하박국", "합"], ["스바냐", "습"],
  ["학개", "학"], ["스가랴", "슥"], ["말라기", "말"],
  ["마태복음", "마"], ["마가복음", "막"], ["누가복음", "눅"], ["요한복음", "요"],
  ["사도행전", "행"], ["로마서", "롬"], ["고린도전서", "고전"], ["고린도후서", "고후"],
  ["갈라디아서", "갈"], ["에베소서", "엡"], ["빌립보서", "빌"], ["골로새서", "골"],
  ["데살로니가전서", "살전"], ["데살로니가후서", "살후"], ["디모데전서", "딤전"],
  ["디모데후서", "딤후"], ["디도서", "딛"], ["빌레몬서", "몬"], ["히브리서", "히"],
  ["야고보서", "약"], ["베드로전서", "벧전"], ["베드로후서", "벧후"], ["요한1서", "요일"],
  ["요한2서", "요이"], ["요한3서", "요삼"], ["유다서", "유"], ["요한계시록", "계"],
];

function guessScripture(text: string): string | null {
  if (!text) return null;
  const sample = text.slice(0, 800);
  // 긴 이름 먼저 시도 (뒤에 숫자가 없어도 인정 - 헷갈릴 일이 적음)
  for (const [full] of BOOKS) {
    if (full.length >= 3 && sample.includes(full)) {
      const idx = sample.indexOf(full);
      const tail = sample.slice(idx, idx + full.length + 12);
      return tail.replace(/\s+/g, " ").trim();
    }
  }
  // 짧은 약자는 뒤에 숫자가 바로 붙을 때만 인정 (오탐 방지)
  for (const [, abbr] of BOOKS) {
    const re = new RegExp(
      `${abbr.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s?\\d{1,3}(:\\d{1,3}(-\\d{1,3})?)?`,
      "g"
    );
    const m = sample.match(re);
    if (m) return m[0];
  }
  return null;
}

function serviceType(title: string): string {
  if (title.includes("주일설교")) return "주일설교";
  if (title.includes("수요설교")) return "수요설교";
  if (title.includes("금요설교")) return "금요설교";
  if (title.includes("새벽설교") || title.includes("새벽기도") || title.includes("특별새벽"))
    return "새벽기도/설교";
  if (title.includes("철야기도") || title.includes("심야기도")) return "철야/심야기도회";
  if (title.includes("부흥회") || title.includes("사경회")) return "부흥회/사경회";
  if (title.includes("경건회")) return "경건회";
  if (title.includes("설교")) return "설교(기타)";
  return "말씀 관련(기타)";
}

// ---------------------------------------------------------------------------
// fast-index.ts / incremental-index.ts와 같은 자가복구 로직
// ---------------------------------------------------------------------------
let consecutiveFailures = 0;
const FAILURE_THRESHOLD = 3;
const MAX_RECOVERY_ATTEMPTS = 2;

async function recoverNotesApp() {
  console.log("  [자가복구] Notes 앱 재시작 시도...");
  try {
    execSync('pkill -f "osascript -l JavaScript"', { stdio: "ignore" });
  } catch {}
  try {
    execSync("killall Notes", { stdio: "ignore" });
  } catch {}
  await sleep(3000);
  try {
    execSync("open -a Notes", { stdio: "ignore" });
  } catch {}
  await sleep(6000);
  console.log("  [자가복구] 완료.");
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  promise.catch(() => {});
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`타임아웃(${ms}ms): ${label}`)), ms)
    ),
  ]);
}

async function getLiteList() {
  const result = await withTimeout(
    runJxa(`
    const app = Application('Notes');
    app.includeStandardAdditions = true;
    const ids = app.notes.id();
    const names = app.notes.name();
    const created = app.notes.creationDate();
    const createdStr = created.map(d => d.toLocaleString());
    return JSON.stringify({ ids, names, created: createdStr });
  `),
    180000,
    "lite-list"
  );
  return JSON.parse(result as string) as { ids: string[]; names: string[]; created: string[] };
}

async function getBodiesByIndicesRaw(indices: number[]) {
  const result = await withTimeout(
    runJxa(`
    const app = Application('Notes');
    app.includeStandardAdditions = true;
    const idxs = ${JSON.stringify(indices)};
    const result = [];
    for (const i of idxs) {
      try {
        const note = app.notes[i];
        result.push({ index: i, content: note.body() });
      } catch (e) {}
    }
    return JSON.stringify(result);
  `),
    30000,
    `indices=${indices.length}`
  );
  if (typeof result !== "string" || result.trim() === "" || result.trim() === "undefined") {
    throw new Error(`빈 응답 (indices=${indices.length})`);
  }
  return JSON.parse(result) as Array<{ index: number; content: string }>;
}

async function getBodiesByIndicesSafe(indices: number[], recoveryAttempt = 0): Promise<Array<any>> {
  if (indices.length === 0) return [];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await getBodiesByIndicesRaw(indices);
      consecutiveFailures = 0;
      return r;
    } catch (e) {
      consecutiveFailures++;
      console.log(`  배치 실패(indices=${indices.length}, 시도${attempt + 1}, 연속${consecutiveFailures}): ${(e as Error).message}`);
      if (consecutiveFailures >= FAILURE_THRESHOLD) {
        await recoverNotesApp();
        consecutiveFailures = 0;
      } else {
        await sleep(1000);
      }
    }
  }
  if (indices.length === 1) {
    if (recoveryAttempt < MAX_RECOVERY_ATTEMPTS) {
      await recoverNotesApp();
      return await getBodiesByIndicesSafe(indices, recoveryAttempt + 1);
    }
    console.log(`  메모 건너뜀(index=${indices[0]})`);
    return [];
  }
  const half = Math.ceil(indices.length / 2);
  const first = await getBodiesByIndicesSafe(indices.slice(0, half), recoveryAttempt);
  const second = await getBodiesByIndicesSafe(indices.slice(half), recoveryAttempt);
  return [...first, ...second];
}

type Record_ = {
  id: string;
  title: string;
  creation_date: string;
  service_type: string;
  content_length: number;
  is_full_manuscript: boolean;
  scripture_guess: string | null;
};

function loadExisting(): Record<string, Record_> {
  try {
    const arr = JSON.parse(fs.readFileSync(OUT_JSON, "utf-8")) as Record_[];
    const map: Record<string, Record_> = {};
    for (const r of arr) map[r.id] = r;
    return map;
  } catch {
    return {};
  }
}

function saveAll(map: Record<string, Record_>) {
  const arr = Object.values(map);
  fs.writeFileSync(OUT_JSON, JSON.stringify(arr, null, 2));
}

function writeSummary(map: Record<string, Record_>) {
  const arr = Object.values(map);
  const byType: Record<string, number> = {};
  const byBook: Record<string, number> = {};
  let manuscriptCount = 0;
  for (const r of arr) {
    byType[r.service_type] = (byType[r.service_type] || 0) + 1;
    if (r.is_full_manuscript) manuscriptCount++;
    if (r.scripture_guess) {
      const bookGuess = r.scripture_guess.replace(/[0-9:\-\s].*$/, "") || r.scripture_guess;
      byBook[bookGuess] = (byBook[bookGuess] || 0) + 1;
    }
  }
  const lines: string[] = [];
  lines.push(`총 후보 메모: ${arr.length}건 (본문 길이 기준 '완성된 원고'로 보이는 것: ${manuscriptCount}건)`);
  lines.push("");
  lines.push("[종류별 개수]");
  for (const [k, v] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${k}: ${v}건`);
  }
  lines.push("");
  lines.push("[본문(추정) 등장 빈도 - 상위]");
  for (const [k, v] of Object.entries(byBook).sort((a, b) => b[1] - a[1]).slice(0, 40)) {
    lines.push(`  ${k}: ${v}건`);
  }
  fs.writeFileSync(OUT_SUMMARY, lines.join("\n"));
}

async function main() {
  console.log(`[${new Date().toISOString()}] 설교 카탈로그 작성 시작`);
  const { ids, names, created } = await getLiteList();
  console.log(`총 ${ids.length}개 메모 중 제목으로 후보를 고릅니다...`);

  const existing = loadExisting();

  const candidateIndices: number[] = [];
  for (let i = 0; i < names.length; i++) {
    const title = names[i] || "";
    if (TITLE_KEYWORDS.some((kw) => title.includes(kw))) {
      if (!existing[ids[i]]) candidateIndices.push(i);
    }
  }
  console.log(`후보 ${candidateIndices.length}건 (이미 처리된 건 제외). 본문을 가져옵니다...`);

  const BATCH_SIZE = 30;
  let done = 0;
  for (let start = 0; start < candidateIndices.length; start += BATCH_SIZE) {
    const indices = candidateIndices.slice(start, start + BATCH_SIZE);
    const bodies = await getBodiesByIndicesSafe(indices);
    for (const b of bodies) {
      const i = b.index;
      let plain = "";
      try {
        plain = turndown(b.content || "");
      } catch {
        plain = b.content || "";
      }
      const title = names[i];
      existing[ids[i]] = {
        id: ids[i],
        title,
        creation_date: created[i],
        service_type: serviceType(title),
        content_length: plain.length,
        is_full_manuscript: plain.length > 1200,
        scripture_guess: guessScripture(title) || guessScripture(plain),
      };
      done++;
    }
    saveAll(existing);
    console.log(`진행: ${done} / ${candidateIndices.length}`);
  }

  saveAll(existing);
  writeSummary(existing);
  console.log(`완료! 총 ${Object.keys(existing).length}건 카탈로그 작성됨.`);
  console.log(`- 상세: ${OUT_JSON}`);
  console.log(`- 요약: ${OUT_SUMMARY}`);
}

main().catch((e) => {
  console.error(`카탈로그 작성 실패: ${e.stack || e.message}`);
  process.exit(1);
});
