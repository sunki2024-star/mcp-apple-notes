#!/bin/bash
# 새 맥에서 애플 메모 색인 환경을 설치하는 스크립트
# 사용법: cd ~/mcp-apple-notes && ./install-mac.sh
set -e
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENTS="$HOME/Library/LaunchAgents"

echo "1) Bun 확인"
if [ ! -x "$HOME/.bun/bin/bun" ]; then
  echo "   Bun이 없어 설치합니다."
  curl -fsSL https://bun.sh/install | bash
fi

echo "2) 패키지 설치"
cd "$PROJECT_DIR" && "$HOME/.bun/bin/bun" install

echo "3) 매주 월요일 새벽 3시 증분 색인 예약"
mkdir -p "$AGENTS"
sed "s#__HOME__#$HOME#g; s#$HOME/mcp-apple-notes#$PROJECT_DIR#g" launchd/com.sunki.noteindex.plist > "$AGENTS/com.sunki.noteindex.plist"
launchctl unload "$AGENTS/com.sunki.noteindex.plist" 2>/dev/null || true
launchctl load "$AGENTS/com.sunki.noteindex.plist"
chmod +x run-incremental-index.sh watchdog.sh

echo
echo "설치 끝. 다음 단계:"
echo " - 처음 한 번은 전체 색인:  cd \"$PROJECT_DIR\" && caffeinate -dims ~/.bun/bin/bun run fast-index.ts | tee index.log"
echo " - 색인이 오래 걸리면 감시(watchdog) 켜기:  ./install-mac.sh --watchdog"
if [ "$1" = "--watchdog" ]; then
  sed "s#__HOME__#$HOME#g; s#$HOME/mcp-apple-notes#$PROJECT_DIR#g" launchd/com.sunki.notewatchdog.plist > "$AGENTS/com.sunki.notewatchdog.plist"
  launchctl unload "$AGENTS/com.sunki.notewatchdog.plist" 2>/dev/null || true
  launchctl load "$AGENTS/com.sunki.notewatchdog.plist"
  echo " - watchdog 켰습니다(5분마다 확인, 색인 완료 후 스스로 꺼짐)."
fi
