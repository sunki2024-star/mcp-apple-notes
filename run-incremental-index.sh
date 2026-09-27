#!/bin/bash
# Apple Notes 증분 색인 실행 스크립트
# launchd(com.sunki.noteindex.plist)가 매주 화요일 오전 11시에 이 스크립트를 실행한다.

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
