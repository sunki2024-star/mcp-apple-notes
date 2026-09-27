import * as lancedb from "@lancedb/lancedb";
import { runJxa } from "run-jxa";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { execSync } from "node:child_process";
import TurndownService from "turndown";
import {
  EmbeddingFunction,
  LanceSchema,
  register,
} from "@lancedb/lancedb/embedding";
import { type Float, Float32, Utf8 } from "apache-arrow";
import { pipeline } from "@huggingface/transformers";

// ---------------------------------------------------------------------------
// incremental-index.ts
//
// fast-index.ts / index-notes 도구는 "전체 메모를 처음부터 다시 읽어서 매번
// 새 행으로 추가"하는 구조라, 반복 실행하면 (1) 이미 색인된 메모까지 다시
// 읽어야 해서 시간이 오래 걸리고 (2) id가 겹치거나 새로 매겨져서 같은 메모가
// 중복으로 쌓인다.
//
// 이 스크립트는 "새로 쓰거나 수정된 메모만" 찾아서 색인에 반영한다:
//   1. 모든 메모의 id / 제목 / 수정일만 "가볍게"(본문 없이) 한 번에 불러온다.
//   2. 지난 실행 때 저장해둔 상태 파일(incremental-state.json)과 비교해서,
//      새로 생긴 메모나 수정일이 바뀐 메모만 골라낸다.
//   3. 그 메모들만 본문을 가져와 변환하고, 같은 제목의 기존 행을 지운 뒤
//      새로 추가한다(수정된 메모가 중복으로 남지 않도록).
//   4. 상태 파일을 갱신한다.
//
// 매일 자동으로 실행하려면 이 저장소에 함께 있는
// com.sunki.noteindex.plist / run-incremental-index.sh 를 참고.
// ---------------------------------------------------------------------------

const { turndown } = new TurndownService();
const db = await lancedb.connect(
  path.join(os.homedir(), ".mcp-apple-notes", "data")
);
const extractor = await pipeline(
  "feature-extraction",
  "Xenova/all-MiniLM-L6-v2"
);

@register("openai")
class OnDeviceEmbeddingFunction extends EmbeddingFunction<string> {
  toJSON(): object {
    return {};
  }
  ndims() {
    return 384;
  }
  embeddingDataType(): Float {
    return new Float32();
  }
  async computeQueryEmbeddings(data: string) {
    const output = await extractor(data, { pooling: "mean" });
    return output.data as number[];
  }
  async computeSourceEmbeddings(data: string[]) {
    return await Promise.all(
      data.map(async (item) => {
        const output = await extractor(item, { pooling: "mean" });
        return output.data as number[];
      })
    );
  }
}
const func = new OnDeviceEmbeddingFunction();

const notesTableSchema = LanceSchema({
  title: func.sourceField(new Utf8()),
  content: func.sourceField(new Utf8()),
  creation_date: func.sourceField(new Utf8()),
  modification_date: func.sourceField(new Utf8()),
  vector: func.vectorField(),
});

async function getNotesTable() {
  const notesTable = await db.createEmptyTable("notes", notesTableSchema, {
    mode: "create",
    existOk: true,
  });
  const indices = await notesTable.listIndices();
  if (!indices.find((i) => i.name === "content_idx")) {
    await notesTable.createIndex("content", {
      config: lancedb.Index.fts(),
      replace: true,
    });
  }
  return notesTable;
}

// ---------------------------------------------------------------------------
// 상태 파일: apple notes의 고유 id -> {title, modification_date}
// "이 메모를 이 수정일 기준으로 이미 색인했다"를 기록해둔다.
// ---------------------------------------------------------------------------
const STATE_PATH = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "incremental-state.json"
);

type StateEntry = { title: string; modification_date: string };
type State = Record<string, StateEntry>;

function loadState(): State {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
  } catch {
    return {};
  }
}
function saveState(state: State) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// fast-index.ts와 동일한 자가복구(self-healing) 로직: Notes.app이 특정
// 메모 때문에 멈추면 좀비 osascript를 정리하고 Notes를 재시작한다.
// ---------------------------------------------------------------------------
let consecutiveFailures = 0;
const FAILURE_THRESHOLD = 3;
const MAX_RECOVERY_ATTEMPTS = 2;

async function recoverNotesApp() {
  console.log(
    "  [자가복구] 연속 실패 감지 - 좀비 osascript 프로세스 정리 및 Notes 앱 재시작을 시도합니다..."
  );
  try {
    execSync('pkill -f "osascript -l JavaScript"', { stdio: "ignore" });
  } catch {}
  try {
    execSync("killall Notes", { stdio: "ignore" });
  } catch {}
  await sleep(3000);
  try {
    execSync("open -a Notes", { stdio: "ignore" });
  } catch (e) {
    console.log(`  [자가복구] Notes 앱 재실행 실패: ${(e as Error).message}`);
  }
  await sleep(6000);
  console.log("  [자가복구] Notes 앱 재시작 완료.");
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  promise.catch(() => {});
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`타임아웃(${ms}ms): ${label}`)), ms)
    ),
  ]);
}

// 본문 없이 모든 메모의 id / 제목 / 수정일만 한 번에 가져온다.
// (본문(body)을 가져오는 것이 느린 부분이고, 속성만 가져오는 건 훨씬 빠르다는
// 전제. 만약 메모 수가 아주 많아 이 한 번의 호출도 오래 걸리면 timeoutMs를
// 늘리거나, 이 함수도 배치로 나누도록 나중에 개선 가능.)
async function getLiteList(timeoutMs = 120000) {
  const result = await withTimeout(
    runJxa(`
    const app = Application('Notes');
    app.includeStandardAdditions = true;
    const ids = app.notes.id();
    const names = app.notes.name();
    const modDates = app.notes.modificationDate();
    const mods = modDates.map(d => d.toLocaleString());
    return JSON.stringify({ ids, names, mods });
  `),
    timeoutMs,
    "lite-list"
  );
  return JSON.parse(result as string) as {
    ids: string[];
    names: string[];
    mods: string[];
  };
}

async function getNotesByIndicesRaw(indices: number[]) {
  const result = await withTimeout(
    runJxa(`
    const app = Application('Notes');
    app.includeStandardAdditions = true;
    const idxs = ${JSON.stringify(indices)};
    const result = [];
    for (const i of idxs) {
      try {
        const note = app.notes[i];
        result.push({
          index: i,
          title: note.name(),
          content: note.body(),
          creation_date: note.creationDate().toLocaleString(),
          modification_date: note.modificationDate().toLocaleString()
        });
      } catch (e) {
        // 개별 메모 접근 실패(삭제됨/손상됨 등)는 건너뛴다.
      }
    }
    return JSON.stringify(result);
  `),
    30000,
    `indices=${indices.length}`
  );
  if (
    typeof result !== "string" ||
    result.trim() === "" ||
    result.trim() === "undefined"
  ) {
    throw new Error(`빈 응답 또는 잘못된 응답 (indices=${indices.length})`);
  }
  return JSON.parse(result) as Array<{
    index: number;
    title: string;
    content: string;
    creation_date: string;
    modification_date: string;
  }>;
}

async function getNotesByIndicesSafe(
  indices: number[],
  recoveryAttempt = 0
): Promise<Array<any>> {
  if (indices.length === 0) return [];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await getNotesByIndicesRaw(indices);
      consecutiveFailures = 0;
      return r;
    } catch (e) {
      consecutiveFailures++;
      console.log(
        `  배치 실패 (indices=${indices.length}, 시도 ${
          attempt + 1
        }, 연속실패 ${consecutiveFailures}회): ${(e as Error).message}`
      );
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
      return await getNotesByIndicesSafe(indices, recoveryAttempt + 1);
    }
    console.log(`  메모 건너뜀 (index=${indices[0]}) - 재시작 후에도 계속 실패`);
    return [];
  }
  const half = Math.ceil(indices.length / 2);
  const first = await getNotesByIndicesSafe(indices.slice(0, half), recoveryAttempt);
  const second = await getNotesByIndicesSafe(indices.slice(half), recoveryAttempt);
  return [...first, ...second];
}

async function main() {
  console.log(`[${new Date().toISOString()}] 증분 색인 시작`);

  const notesTable = await getNotesTable();
  const state = loadState();

  console.log("현재 메모 목록(속성만) 조회 중...");
  const { ids, names, mods } = await getLiteList();
  console.log(`총 ${ids.length}개 메모 확인됨.`);

  const currentIdSet = new Set(ids);
  const toProcess: number[] = [];
  for (let i = 0; i < ids.length; i++) {
    const prev = state[ids[i]];
    if (!prev || prev.modification_date !== mods[i]) {
      toProcess.push(i);
    }
  }

  // 삭제된 메모(상태 파일엔 있지만 현재 목록엔 없는 것) 처리.
  const deletedTitles: string[] = [];
  for (const [id, entry] of Object.entries(state)) {
    if (!currentIdSet.has(id)) {
      deletedTitles.push(entry.title);
    }
  }

  console.log(
    `신규/변경 메모 ${toProcess.length}건, 삭제 감지 ${deletedTitles.length}건.`
  );

  if (toProcess.length === 0 && deletedTitles.length === 0) {
    console.log("변경 사항 없음. 증분 색인 완료.");
    return;
  }

  for (const title of deletedTitles) {
    try {
      const escaped = title.replace(/'/g, "''");
      await notesTable.delete(`title = '${escaped}'`);
    } catch (e) {
      console.log(`  삭제된 메모 정리 실패(title="${title}"): ${(e as Error).message}`);
    }
  }
  for (const [id, entry] of Object.entries(state)) {
    if (!currentIdSet.has(id)) delete state[id];
  }

  const BATCH_SIZE = 40;
  let processed = 0;
  for (let start = 0; start < toProcess.length; start += BATCH_SIZE) {
    const indices = toProcess.slice(start, start + BATCH_SIZE);
    const batch = await getNotesByIndicesSafe(indices);
    for (const note of batch) {
      if (!note.title) continue;
      let content = note.content || "";
      try {
        content = turndown(content);
      } catch {}
      try {
        const escaped = note.title.replace(/'/g, "''");
        await notesTable.delete(`title = '${escaped}'`);
      } catch (e) {
        console.log(`  기존 행 삭제 실패(title="${note.title}"): ${(e as Error).message}`);
      }
      await notesTable.add([
        {
          id: ids[note.index],
          title: note.title,
          content,
          creation_date: note.creation_date,
          modification_date: note.modification_date,
        },
      ]);
      state[ids[note.index]] = {
        title: note.title,
        modification_date: note.modification_date,
      };
      processed++;
    }
    saveState(state); // 배치마다 저장해서 중간에 죽어도 이어서 할 수 있게.
    console.log(`진행: ${processed} / ${toProcess.length}`);
  }

  saveState(state);
  console.log(
    `증분 색인 완료! 새로 추가/갱신 ${processed}건, 삭제 정리 ${deletedTitles.length}건.`
  );
}

main().catch((e) => {
  console.error(`증분 색인 실패: ${e.stack || e.message}`);
  process.exit(1);
});
