#!/usr/bin/env python3
"""
애플 메모 색인(~/.mcp-apple-notes/data/notes.lance)에서 설교 메모를 뽑아 내는 도구.

색인 데이터가 크기(수 GB) 때문에 한 번에 다 읽지 말고 파일 10개씩 나누어 실행합니다.
  python3 tools/extract-sermons.py --book 신명기 --abbr 신 --from 2024-04 --to 2024-10 --start 0 --end 10
  python3 tools/extract-sermons.py --book 신명기 --abbr 신 --from 2024-04 --to 2024-10 --start 10 --end 20
  ... (파일 수는 --count 로 확인)
결과: "Claude outputs/<book>_<start>.json" 에 {날짜|길이: 메모 본문(HTML)} 형태로 저장.
제목이 "2024년 4월 7일 ..." 처럼 날짜로 시작하는 메모만 찾고, 본문에 책 이름이나 [약어N:... 표시가 있는 것만 고릅니다.
"""
import argparse, glob, json, os, re, sys

DATA = os.environ.get('NOTES_DB') or next((d for d in [os.path.expanduser('~/.mcp-apple-notes/data/notes.lance/data'), os.path.expanduser('~/mnt/.mcp-apple-notes/data/notes.lance/data')] if os.path.isdir(d)), os.path.expanduser('~/.mcp-apple-notes/data/notes.lance/data'))
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'Claude outputs')
T = '(?:<[^>]+>)*'

ap = argparse.ArgumentParser()
ap.add_argument('--book', help='성경 책 이름, 예: 신명기')
ap.add_argument('--abbr', default='', help='약어, 예: 신  ([신11:8] 같은 표시 찾기)')
ap.add_argument('--from', dest='frm', default='2000-01', help='시작 연-월, 예: 2024-04')
ap.add_argument('--to', default='2099-12', help='끝 연-월, 예: 2024-10')
ap.add_argument('--start', type=int, default=0)
ap.add_argument('--end', type=int, default=10)
ap.add_argument('--count', action='store_true', help='색인 파일 수만 출력')
a = ap.parse_args()

files = sorted(glob.glob(os.path.join(DATA, '*.lance')))
if a.count:
    print(len(files)); sys.exit()
fy, fm = map(int, a.frm.split('-')); ty, tm = map(int, a.to.split('-'))
os.makedirs(OUT, exist_ok=True)
res = {}
for f in files[a.start:a.end]:
    b = open(f, 'rb').read().decode('utf8', 'ignore')
    for m in re.finditer(r'<h1>', b):
        head = re.sub('<[^>]+>', '', b[m.start():m.start()+400])
        mm = re.match(r'\s*(20\d\d)\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일', head)
        if not mm: continue
        y, mo = int(mm.group(1)), int(mm.group(2))
        if (y, mo) < (fy, fm) or (y, mo) > (ty, tm): continue
        seg = b[m.start():m.start()+800000]
        seg = re.sub(r'data:image/[^"]*"', '"', seg)          # 그림 데이터 제거
        i = seg.find('<div><h1>', 50)
        seg = seg[:i] if i > 0 else seg[:120000]
        text = re.sub('<[^>]+>', ' ', seg)
        if a.book and a.book not in text and not (a.abbr and re.search(r'\[' + re.escape(a.abbr) + r'\d', text)):
            continue
        key = f'{y}-{mo:02d}-{int(mm.group(3)):02d}|{len(seg)}'
        res[key] = seg
        print(key, head[:40].replace('\n', ' / '))
name = f"{a.book or 'notes'}_{a.start}.json"
json.dump(res, open(os.path.join(OUT, name), 'w'), ensure_ascii=False)
print('저장:', os.path.join(OUT, name), len(res), '건')
