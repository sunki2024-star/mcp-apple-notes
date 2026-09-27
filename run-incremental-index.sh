#!/bin/bash
# Apple Notes 증분 색인 실행 스크립트
# launchd(com.sunki.noteindex.plist)가 매주 월요일 새벽 3시에 이 스크립트를 실행한다.

HOME_DIR="$HOME"
PROJECT_DIR="$HOME_DIR/mcp-apple-notes"
LOG="$PROJECT_DIR/incremental-index.log"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 증분 색인 실행 시작" >> "$LOG"

# Notes.app이 꺼져 있으면 켜준다.
if ! pgrep -x "Notes" > /dev/null; then
  open -a Notes
  sleep 5
fi

cd "$PROJECT_DIR" || exit 1
caffeinate -dims "$HOME_DIR/.bun/bin/bun" run incremental-index.ts >> "$LOG" 2>&1

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 증분 색인 실행 종료" >> "$LOG"

# 끝난 뒤: 10분 이상 아무도 맥을 쓰지 않았다면(예약으로 깨운 경우) 다시 잠자기로 돌린다.
# 누가 맥을 쓰고 있으면 그대로 둔다.
IDLE=$(ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print int($NF/1000000000); exit}')
if [ -n "$IDLE" ] && [ "$IDLE" -gt 600 ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ${IDLE}초 동안 사용 없음 → 잠자기" >> "$LOG"
  pmset sleepnow
fi
