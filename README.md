# 구슬 레이스 추첨

최대 1000개의 구슬이 핀볼 코스를 굴러 내려가 결승선 도착 순서로 당첨을 정하는 추첨기.
서버 없이 브라우저에서 물리 시뮬레이션을 돌리고, Cloudflare 정적 자산(Workers Free)으로 배포한다.

- 입력: 줄바꿈·쉼표로 구분, `이름*3`은 같은 이름 3개, `1~100`은 번호 구슬
- 코스: 유성 폭포 · 풍차 언덕 · 네온 카오스, 길이 짧게/보통/길게
- 당첨: 먼저 도착 · 마지막 도착 · N번째 도착, 당첨 개수 지정
- 연출: 대시·충격파·돌풍 이벤트, 결승 슬로모션, 합성 효과음·배경 음악, webm 녹화
- 공정성: 결과는 미리 정해지지 않는다. 같은 참가자·코스·시드면 같은 레이스가 재현된다(고정 스텝 물리 + 시드 RNG)
- 아이콘은 Lucide(ISC), 폰트는 Pretendard(OFL)

## 구조

- `src/physics.ts` 고정 스텝(1/240초) 물리: 공간 격자로 구슬 충돌, 핀·범퍼·벽·회전 풍차
- `src/map.ts` 코스 구간 조합. 모든 틈은 가장 큰 구슬보다 넓어 끼이지 않는다
- `src/engine.ts` 캔버스 렌더링·카메라·당첨 판정, `src/audio.ts` WebAudio 합성음
- `src/App.tsx` 설정 패널·HUD·결과 화면

## 개발

```sh
pnpm install
pnpm dev                 # http://localhost:5180
pnpm typecheck
node scripts/shot.mjs http://localhost:5180/ /tmp/draw-shots 1000   # headless 1000개 레이스 스크린샷
pnpm run deploy          # 빌드 후 Cloudflare 배포 (Worker marble-draw)
```
