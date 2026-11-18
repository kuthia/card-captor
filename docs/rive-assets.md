# Rive 샘플 자산

검토일: 2026-11-18. 캐릭터 표현 검증에는 Rive 공식 Web 런타임 저장소의 **Centaur Character** 샘플 한 개를 사용한다. Tauri·React의 이동·드래그·카드 UI와 모델 재생을 결합하는 검증이며 자체 캐릭터 제작 완료를 뜻하지 않는다.

## 출처와 고정 버전

| 항목 | 값 |
| --- | --- |
| 저장소 | [`rive-app/rive-wasm`](https://github.com/rive-app/rive-wasm) |
| 고정 commit | [`9acb00a58695422cd108aa2bd6a31966710f8d31`](https://github.com/rive-app/rive-wasm/tree/9acb00a58695422cd108aa2bd6a31966710f8d31) |
| 원본 파일 | [`wasm/examples/centaur_game/centaur.riv`](https://github.com/rive-app/rive-wasm/blob/9acb00a58695422cd108aa2bd6a31966710f8d31/wasm/examples/centaur_game/centaur.riv) |
| 앱 파일 | [`public/rive/sample.riv`](../public/rive/sample.riv), URL `/rive/sample.riv` |
| 크기 | 46,302 bytes |
| Git blob SHA-1 | `f37826e07124fbf339c0246a5e3525c27950ffa7` |
| SHA-256 | `8fc833d1a98ebf803521375e570b4dbcd36e15c79c45eab4e411421392f2f764` |
| 변형 여부 | 없음. 앱 내부 파일명만 `sample.riv`로 지정하고 `Character` artboard를 선택 |

다운로드한 파일의 Git blob SHA-1을 공식 고정 commit의 파일 정보와 대조했다. 기계가 읽을 수 있는 출처·해시는 [`provenance.json`](../public/rive/provenance.json)에 보관한다. 실행 중에는 GitHub·Rive CDN에서 모델을 받지 않고 앱 번들의 로컬 파일을 읽는다.

## 사용 조건

고정한 공식 저장소의 최상위 [MIT License](https://github.com/rive-app/rive-wasm/blob/9acb00a58695422cd108aa2bd6a31966710f8d31/LICENSE)를 확인했고, `wasm/examples/centaur_game`에 별도의 라이선스 예외 파일은 없었다. 원문의 `Copyright (c) 2020-2021 Rive`와 MIT 고지를 [`LICENSE.rive-sample.txt`](../public/rive/LICENSE.rive-sample.txt)에 포함한다. 런타임 코드의 패키지 라이선스와 샘플 파일 출처는 별도로 유지한다.

Web 런타임 `@rive-app/webgl2-advanced` 2.51.0의 npm 메타데이터는 MIT와 `gitHead` `81fe4a7087198392cbfde26f827873469366d9dc`를 명시한다. 해당 공식 소스 commit의 [MIT 원문](https://github.com/rive-app/rive-wasm/blob/81fe4a7087198392cbfde26f827873469366d9dc/LICENSE)을 [`LICENSE.rive-runtime.txt`](../public/rive/LICENSE.rive-runtime.txt)에 포함한다. npm 배포본에 LICENSE 파일이 없어도 고지가 번들에 들어가도록 별도 보관하며, 라이선스 출처·해시도 `provenance.json`의 `runtime`에 기록한다.

이번 검증은 공식 저장소에 배포된 샘플을 그대로 사용한다. 계정 생성·유료 플랜 결제·Rive Editor에서의 새 export는 하지 않는다. 자체 파일을 새로 만들 때는 [현재 플랜의 export 조건](https://rive.app/docs/account-admin/pricing)을 적용한다. 무료 플랜 export의 Rive 시작 화면 조건을 이 샘플의 저장소 라이선스와 혼동하지 않는다.

## 표현과 행동 매핑의 범위

`@rive-app/webgl2-advanced` 2.51.0의 WASM으로 파일을 실제 import해 확인한 메타데이터는 다음과 같다.

| 항목 | 값 |
| --- | --- |
| 선택 artboard | `Character` |
| artboard bounds | `(0, 0)`–`(500, 500)` |
| animation | `WalkBack`, `Aim`, `Idle`, `Walk`, `Fire`, `Blink`, `Idle_fire` |
| 별도 배경 | `Background_tile` 등 다른 artboard는 선택하지 않음 |

`Character`는 활을 든 분홍색 돼지 켄타우로스다. 실제 `Idle`·`Walk`·`WalkBack`·`Blink` 모션이 있다. 드래그 반응은 `Aim`, 카드 열람은 `Idle + Blink`로 연결하며 `Idle_fire`는 이번 매핑에서 사용하지 않는다. 원본 모델에 잡힘·읽기 전용 동작이 있다는 뜻은 아니다. 앱의 상태와 화면상의 공간 이동은 Card Captor가 소유한다. 원본 모션과 앱이 추가하는 자세·배치 효과를 구분해 검증 결과에 기록한다.

Node의 임시 Canvas2D 검사 도구(`@rive-app/canvas-advanced` 2.51.0 + `@napi-rs/canvas`)로 `Character`의 `Idle`을 500×500 PNG에 그린 결과, 전체 250,000픽셀 중 203,945픽셀은 alpha 0, 43,843픽셀은 alpha 255, 나머지 2,212픽셀은 부분 투명도였다. 이미지에서도 배경 사각형 없이 캐릭터만 표시되는 것을 확인했다. 이 사전 검사는 앱의 WebGL2/macOS 합성 검증을 대신하지 않는다. 실행 시 168×160 viewport의 fit·투명 경계·클리핑을 별도로 확인한다.

초기 후보였던 Little Machine은 실제 앱에서 배경 gradient 사각형과 큰 artboard 여백이 확인돼 채택하지 않았다. 해당 파일·이전 출처 기록은 `.artifacts/rive-sample/little-machine-original`에만 로컬 보관하고 배포용 `public/rive`에는 최종 샘플 한 개만 둔다.

자산 실패 시 기존 로봇으로 돌아갈 수 있어야 하며, 실제 업무 카드나 Notion 토큰은 모델 검증에 필요하지 않다. 네 상태의 실제 실행 결과와 최종 행동 매핑은 Rive 검증 보고서에서 다룬다.
