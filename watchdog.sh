#!/bin/bash
# Apple Notes 색인 감시(watchdog) 스크립트
# index.log이 30분 이상 갱신되지 않고 아직 완료되지 않았으면 Notes 앱과 색인 프로세스를 자동으로 재시작합니다.

HOME_DIR="$HOME"
PROJECT_DIR="$HOME_DIR/mcp-apple-notes"
LOG="$PROJECT_DIR/index.log"
PLIST="$HOME_DIR/Library/LaunchAgents/com.sunki.notewatchdog.plist"
STALE_SECONDS=1800   # 30분

echo "[$(date '+%Y-%m-%d %H:%M:%S')] watchdog 체크 시작" 

if [ ! -f "$LOG" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] index.log 없음, 종료"
  exit 0
fi

if grep -q "색인 완료!" "$LOG"; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] 색인 완료 확인됨. watchdog 자동 해제."
  launchctl unload "$PLIST" 2>/dev/null
  exit 0
fi

NOW=$(date +%s)
MTIME=$(stat -f %m "$LOG")
DIFF=$(( NOW - MTIME ))

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 마지막 갱신 후 ${DIFF}초 경과"

if [ "$DIFF" -gt "$STALE_SECONDS" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ${STALE_SECONDS}초 이상 정체됨. 재시작 시도."

  if pgrep -f "fast-index.ts" > /dev/null; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] 기존 fast-index.ts 프로세스 종료"
    pkill -f "fast-index.ts"
    sleep 2
  fi

  killall Notes 2>/dev/null
  sleep 3
  open -a Notes
  sleep 5
  cd "$PROJECT_DIR" || exit 1
  nohup caffeinate -dims "$HOME_DIR/.bun/bin/bun" run fast-index.ts >> "$LOG" 2>&1 &
  disown
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] 재시작 명령 실행 완료 (PID: $!)"
else
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] 정상 진행 중, 조치 없음"
fi
