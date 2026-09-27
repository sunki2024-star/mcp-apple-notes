import * as lancedb from "@lancedb/lancedb";
import { runJxa } from "run-jxa";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import TurndownService from "turndown";
import {
  EmbeddingFunction,
  LanceSchema,
  register,
} from "@lancedb/lancedb/embedding";
import { type Float, Float32, Utf8 } from "apache-arrow";
import { pipeline } from "@huggingface/transformers";

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

async function createNotesTable(overrideName?: string) {
  const notesTable = await db.createEmptyTable(
    overrideName || "notes",
    notesTableSchema,
    { mode: "create", existOk: true }
  );
  const indices = await notesTable.listIndices();
  if (!indices.find((i) => i.name === "content_idx")) {
    await notesTable.createIndex("content", {
      config: lancedb.Index.fts(),
      replace: true,
    });
  }
  return notesTable;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 자가 복구(self-healing) 로직
//
// 근본 원인: runJxa()는 내부적으로 osascript 프로세스를 띄우는데, 우리가 거는
// 30초 타임아웃은 "우리 쪽에서 기다리기를 포기"할 뿐 실제 osascript 프로세스를
// 죽이지는 못한다 (run-jxa 라이브러리가 해당 child process 핸들을 넘겨주지
// 않기 때문). Notes.app이 특정 메모(큰 첨부파일/손상된 메모 등) 처리 중
// 멈추면, 그 osascript 프로세스는 Notes.app의 응답을 영원히 기다리며 좀비로
// 남는다. 이런 좀비가 쌓이면 Notes.app의 Apple Event 처리 큐가 밀려서,
// 이후의 모든 요청(배치 크기 1짜리도 포함)이 전부 타임아웃되는 연쇄 장애로
// 번진다. 지금까지는 외부 watchdog(launchd, 5분 간격)이 이 상태를 감지해서
// Notes.app을 강제 재시작해 왔는데, 그 watchdog 자체가 알 수 없는 이유로
// 멈추면 아무도 복구해주지 않는 단일 장애점이 된다.
//
// 그래서 이 복구 로직을 스크립트 안으로 옮겼다: 연속 실패가 일정 횟수를
// 넘으면 외부 watchdog을 기다리지 않고 스크립트가 스스로 좀비 osascript를
// 정리하고 Notes.app을 재시작한다.
// ---------------------------------------------------------------------------

let consecutiveFailures = 0;
const FAILURE_THRESHOLD = 3; // 이 횟수만큼 연속 실패하면 자가 복구 트리거
const MAX_RECOVERY_ATTEMPTS_PER_NOTE = 2; // 메모 1개 기준, 복구 후에도 계속 실패하면 포기

async function recoverNotesApp() {
  console.log(
    "  [자가복구] 연속 실패 감지 - 좀비 osascript 프로세스 정리 및 Notes 앱 재시작을 시도합니다..."
  );
  try {
    execSync('pkill -f "osascript -l JavaScript"', { stdio: "ignore" });
  } catch {
    // 죽일 프로세스가 없으면 pkill이 exit code 1을 내는데, 정상 상황이므로 무시.
  }
  try {
    execSync("killall Notes", { stdio: "ignore" });
  } catch {
    // Notes가 이미 꺼져 있으면 마찬가지로 무시.
  }
  await sleep(3000);
  try {
    execSync("open -a Notes", { stdio: "ignore" });
  } catch (e) {
    console.log(`  [자가복구] Notes 앱 재실행 실패: ${(e as Error).message}`);
  }
  await sleep(6000);
  console.log("  [자가복구] Notes 앱 재시작 완료. 색인을 계속 진행합니다.");
}

// JXA(AppleScript) 호출이 특정 메모(큰 첨부파일, 손상된 메모 등) 때문에
// 영영 응답하지 않고 멈춰버리는 경우가 있어, 타임아웃을 걸어서
// 일정 시간 안에 응답이 없으면 에러로 처리하고 넘어가도록 한다.
// (원래 호출 자체를 강제로 죽일 수는 없어서, 백그라운드에 남겨두고 무시한다.
//  대신 recoverNotesApp()이 주기적으로 좀비 osascript를 정리해준다.)
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  promise.catch(() => {}); // 백그라운드에 남는 원래 promise가 unhandled rejection을 내지 않도록.
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`타임아웃(${ms}ms): ${label}`)), ms)
    ),
  ]);
}

async function getTitleCount() {
  const count = await runJxa(`
    const app = Application('Notes');
    app.includeStandardAdditions = true;
    return app.notes.length;
  `);
  return count as number;
}

// 이전 버전은 매 배치마다 Array.from(app.notes())로 전체 메모 목록을
// 통째로 다시 만든 뒤 slice()했다. 메모 개수가 많아질수록(9745개) 이 작업
// 자체가 점점 무거워지고, Notes.app 부하도 누적된다. 인덱스로 필요한
// 범위만 직접 접근하도록 바꿔서 매 호출의 부담을 줄인다.
async function getNotesBatchRaw(start: number, count: number) {
  const result = await withTimeout(
    runJxa(`
    const app = Application('Notes');
    app.includeStandardAdditions = true;
    const result = [];
    for (let i = ${start}; i < ${start + count}; i++) {
      try {
        const note = app.notes[i];
        result.push({
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
    `start=${start} count=${count}`
  );
  if (
    typeof result !== "string" ||
    result.trim() === "" ||
    result.trim() === "undefined"
  ) {
    throw new Error(`빈 응답 또는 잘못된 응답 (start=${start}, count=${count})`);
  }
  return JSON.parse(result) as Array<{
    title: string;
    content: string;
    creation_date: string;
    modification_date: string;
  }>;
}

// 배치가 실패하면 재시도하고, 계속 실패하면 배치를 절반으로 나눠서 다시 시도.
// 연속 실패 횟수가 임계치를 넘으면 Notes 앱을 스스로 재시작한다.
// 메모 1개까지 쪼개졌는데도 실패하면, 재시작을 몇 번 더 시도해보고
// 그래도 안 되면 그 메모만 건너뛰고 로그로 남긴다.
async function getNotesBatchSafe(
  start: number,
  count: number,
  recoveryAttempt = 0
): Promise<Array<any>> {
  if (count <= 0) return [];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await getNotesBatchRaw(start, count);
      consecutiveFailures = 0;
      return r;
    } catch (e) {
      consecutiveFailures++;
      console.log(
        `  배치 실패 (start=${start}, count=${count}, 시도 ${
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
  if (count === 1) {
    if (recoveryAttempt < MAX_RECOVERY_ATTEMPTS_PER_NOTE) {
      console.log(
        `  메모 1개(index=${start}) 계속 실패 - Notes 재시작 후 재시도 (${
          recoveryAttempt + 1
        }/${MAX_RECOVERY_ATTEMPTS_PER_NOTE})`
      );
      await recoverNotesApp();
      return await getNotesBatchSafe(start, count, recoveryAttempt + 1);
    }
    console.log(`  메모 1개 건너뜀 (index=${start}) - 재시작 후에도 계속 실패`);
    return [];
  }
  const half = Math.ceil(count / 2);
  const first = await getNotesBatchSafe(start, half, recoveryAttempt);
  const second = await getNotesBatchSafe(start + half, count - half, recoveryAttempt);
  return [...first, ...second];
}

async function indexAllNotes() {
  console.log("전체 메모 개수 확인 중...");
  const total = await getTitleCount();
  console.log(`총 ${total}개 메모를 색인합니다.`);

  const notesTable = await createNotesTable();

  // 이미 색인된 개수만큼 건너뛰고 이어서 진행 (중단됐던 지점부터 재시작)
  const already = await notesTable.countRows();
  let startFrom = 0;
  if (already > 0) {
    startFrom = Math.floor(already / 200) * 200;
    console.log(`이미 ${already}개 색인되어 있어 ${startFrom}번째부터 이어서 진행합니다.`);
  }

  const batchSize = 200;
  let done = startFrom;
  for (let start = startFrom; start < total; start += batchSize) {
    const size = Math.min(batchSize, total - start);
    const t0 = Date.now();
    const batch = await getNotesBatchSafe(start, size);
    const chunks = batch
      .filter((n) => n.title)
      .map((note, i) => {
        let content = note.content || "";
        try {
          content = turndown(content);
        } catch {}
        return {
          id: (start + i).toString(),
          title: note.title,
          content,
          creation_date: note.creation_date,
          modification_date: note.modification_date,
        };
      });
    if (chunks.length > 0) {
      await notesTable.add(chunks);
    }
    done = start + size;
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`진행: ${done} / ${total} (이번 배치 ${secs}초)`);
  }

  console.log("색인 완료!");
}

// 최상위 레벨에서도 한 번 더 안전망을 둔다: indexAllNotes()가 예상치 못한
// 이유(LanceDB 오류 등)로 통째로 실패해도 프로세스를 죽이지 않고, Notes
// 앱을 재시작한 뒤 이어서 진행한다. 실제로 완료("색인 완료!")될 때까지는
// 스스로 재시도하며, 사람이 터미널에서 다시 실행해줄 필요가 없게 한다.
async function main() {
  const MAX_TOP_LEVEL_RETRIES = 20;
  for (let i = 0; i < MAX_TOP_LEVEL_RETRIES; i++) {
    try {
      await indexAllNotes();
      return; // "색인 완료!"까지 정상 종료
    } catch (e) {
      console.error(
        `오류 발생 (전체 재시도 ${i + 1}/${MAX_TOP_LEVEL_RETRIES}): ${
          (e as Error).stack || (e as Error).message
        }`
      );
      await recoverNotesApp();
      await sleep(5000);
    }
  }
  console.error("최대 재시도 횟수를 초과했습니다. 수동 확인이 필요합니다.");
  process.exit(1);
}

main();
