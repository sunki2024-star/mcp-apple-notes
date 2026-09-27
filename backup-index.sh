#!/bin/bash
# 애플 메모 색인 데이터(~/.mcp-apple-notes)를 iCloud Drive로 백업하는 스크립트
# run-incremental-index.sh가 매주 증분 색인을 마친 뒤에 자동으로 호출한다.
# (색인 폴더 자체를 iCloud 경로로 옮기지 않는 이유: 색인 프로그램이 계속 쓰고 있는
#  살아있는 데이터베이스라서, iCloud가 동시에 건드리면 파일이 깨질 수 있기 때문.
#  대신 색인이 다 끝난 뒤 완성된 상태를 iCloud로 복사만 해 둔다.)

HOME_DIR="$HOME"
SRC="$HOME_DIR/.mcp-apple-notes"
DEST="$HOME_DIR/Library/Mobile Documents/com~apple~CloudDocs/mcp-apple-notes-백업"
LOG="$HOME_DIR/mcp-apple-notes/backup.log"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 백업 시작" >> "$LOG"

if [ ! -d "$SRC" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] 색인 폴더가 없어 백업을 건너뜀: $SRC" >> "$LOG"
  exit 0
fi

# 안전장치: 색인 폴더 크기가 비정상적으로 작으면(색인이 깨졌거나 진행 중일 가능성)
# 백업을 건너뛴다. 정상 크기는 보통 수백 MB~수 GB.
SRC_SIZE_KB=$(du -sk "$SRC" 2>/dev/null | cut -f1)
if [ -z "$SRC_SIZE_KB" ] || [ "$SRC_SIZE_KB" -lt 51200 ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] 색인 폴더 크기가 비정상적으로 작아(${SRC_SIZE_KB:-0}KB) 백업을 건너뜀" >> "$LOG"
  exit 0
fi

mkdir -p "$DEST"

rsync -a --delete "$SRC/" "$DEST/" >> "$LOG" 2>&1
STATUS=$?

if [ $STATUS -eq 0 ]; then
  echo "마지막 백업: $(date '+%Y-%m-%d %H:%M:%S')" > "$DEST/마지막_백업_시간.txt"
  echo "원본 크기: 약 $((SRC_SIZE_KB / 1024))MB" >> "$DEST/마지막_백업_시간.txt"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] 백업 완료 (${SRC_SIZE_KB}KB)" >> "$LOG"
else
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] 백업 실패 (rsync 종료 코드 $STATUS)" >> "$LOG"
fi
