# Card Captor

Codex 작업 상태와 Notion GTD 카드를 보여주는 데스크톱 캐릭터 위젯입니다. Codex 작업 완료·확인 요청·실패를 피드, 말풍선, OS 알림과 사운드로 알려 줍니다. 캐릭터는 화면을 돌아다니고, 피드나 설정을 여는 동안에는 멈춥니다.

Tauri 2와 React로 구성하며 macOS와 Windows를 대상으로 합니다. 첫 버전은 **주 모니터의 작업 영역**에서 동작합니다.

카드 덱이나 연결 설정 상단의 **캐릭터 선택**에서 캡터·웰루니·공식 Rive `Centaur` 샘플을 미리 보고 변경할 수 있습니다. 일반 모드의 선택은 Notion 연결 없이 저장되며 재실행과 연결 해제 후에도 유지됩니다. 웰루니는 [캐릭터보드](https://welluni-toon-preview.hepark106.chatgpt.site/characters/#01-welluni)의 정면 모습을 바탕으로 준비한 투명 PNG를 사용합니다.

캡터·웰루니는 PixiJS로 그리며 대기 중 연속 프레임을 멈춥니다. Rive는 대기·열람 중에도 모션을 재생합니다. 연속 갱신은 최대 30 FPS를 목표로 하며 WebGL 실패 시 정적인 대체 이미지를 표시합니다.

## 실행

Node.js 24 이상, pnpm 12, Rust stable이 필요합니다. macOS는 Xcode Command Line Tools, Windows는 MSVC C++ Build Tools와 WebView2가 필요합니다. 설치 방법은 [Tauri 개발 환경 문서](https://v2.tauri.app/start/prerequisites/)를 따릅니다.

```sh
pnpm install --frozen-lockfile
pnpm desktop
```

`pnpm dev`는 브라우저 미리보기를 실행합니다. 이동·드래그·카드 패널과 명시적인 Codex 합성 시나리오를 확인할 수 있습니다. 실제 Codex 관측·OS 알림·사운드와 Notion 연결은 데스크톱 앱에서 제공합니다.

| 명령 | 용도 |
| --- | --- |
| `pnpm test` | 이동·입력·갱신·렌더러 수명 주기 테스트 |
| `pnpm build` | TypeScript 검사와 프런트엔드 빌드 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked` | Codex 구독·상태 전이·설정과 Notion 응답 변환 테스트 |
| `pnpm desktop:build` | 현재 OS용 데스크톱 앱 빌드 |
| `pnpm desktop:rive` | Rive 샘플·합성 카드로 대화형 데스크톱 검증 |
| `pnpm desktop:build:rive --bundles app` | macOS Rive 검증 feature를 포함한 앱 번들 생성 |

일반 모드는 `pnpm desktop`으로 실행하고, 기존 Notion 연결을 사용하는 카드 패널에서 Rive를 선택합니다. 캐릭터 선택만 바꿀 때는 키체인이나 Notion을 호출하지 않습니다. 선택 저장에 실패하면 기존 캐릭터와 오류 안내를 유지합니다.

합성 카드를 사용하는 Rive 검증은 기존 Card Captor를 종료한 뒤 `pnpm desktop:rive`로 실행합니다. 검증 모드에서는 실제 설정·키체인·Notion에 접근하지 않으며 캐릭터 선택도 메모리에서만 변경합니다. 브라우저 미리보기의 선택도 저장하지 않습니다. 검증 feature가 있는 빌드도 인자 없이 실행하면 저장된 캐릭터와 실제 Notion 연결을 사용하는 일반 모드입니다. 릴리스 검증에는 `--character-validation` 인자를 전달합니다.

모델은 MIT로 제공된 공식 샘플이며 실행 중 외부 CDN에서 받지 않습니다. 출처와 사용 조건은 [Rive 자산 문서](docs/rive-assets.md), 상태 매핑·모드별 실행·검증 결과는 [Rive 동작 검증](docs/rive-validation.md)에 정리했습니다.

## Codex 작업 따라가기

1. macOS·Linux에서 Codex 앱과 Card Captor를 실행합니다. 캐릭터를 누르면 기본으로 **Codex 작업** 탭이 열립니다.
2. Codex 앱에서 로컬 대화를 엽니다. 최근 세션 후보 중 앱이 소유한 작업과 새로 선택한 작업을 최대 12개 따라갑니다.
3. **알림**, **사운드**를 각각 켜거나 끄고 **알림 테스트**로 확인합니다. **Codex 작업 따라가기**를 끄면 구독도 해제됩니다.
4. 피드의 작업 제목을 누르면 Codex 대화가 열립니다. 응답과 승인은 Codex 앱에서 진행합니다.

피드를 닫으면 캐릭터 곁에 **제목 한 줄 + 최신 진행 내용 한 줄**의 말풍선이 표시됩니다. 진행 중·확인 대기 동안 실시간 갱신하고, 완료·실패·중단은 6.5초 후 숨깁니다. 팝업 피드의 작업·최근 활동은 항목 전체를 눌러 해당 `codex://threads/{id}` 대화로 이동할 수 있습니다.

이 연결은 **비공개 `ipc.sock` 프로토콜을 사용하는 비공식 연동**입니다. 작업 시작·메시지 전송·승인 기능은 없으며 최초 접속과 재연결 시 기존 완료 상태를 재알림하지 않습니다. Windows의 Codex 관측은 이번 버전에 포함하지 않았습니다. OS 알림 표시는 시스템 권한과 집중 모드 설정의 영향을 받습니다. 지원 버전·수신 한도·검증 결과는 [Codex 관측 문서](docs/codex-observer.md)에 정리했습니다.

## Notion 연결

1. 표시할 GTD 데이터베이스의 **뷰 링크 또는 뷰 ID**를 준비합니다.
2. Notion 토큰을 준비합니다. 내부 연결을 사용하면 해당 데이터베이스와 뷰가 있는 페이지에 읽기 권한을 부여합니다.
3. 캐릭터의 카드 패널에서 설정을 열고 뷰와 토큰을 저장합니다.
4. 카드 제목으로 원본을 열거나, 상태 배지를 눌러 실제 Notion 상태 선택지로 바로 변경합니다. 상태 변경에는 연결의 콘텐츠 업데이트 권한이 필요합니다.

현재 Notion API는 저장된 뷰의 필터와 정렬을 실행할 수 있으므로 위젯에서 조건을 다시 작성하지 않습니다. 담당자에 **‘나’**를 사용하는 뷰라면 사용자 권한으로 실행하는 PAT가 적합합니다. 내부 연결은 별도 봇이므로 같은 조건이 사용자의 ‘나’를 의미하지 않습니다. [뷰 API](https://developers.notion.com/guides/data-apis/working-with-views), [PAT](https://developers.notion.com/guides/connections-and-tokens/personal-access-tokens), [People 필터](https://developers.notion.com/reference/filter-data-source-entries#people)

토큰은 OS 자격증명 저장소에 보관합니다. 설정과 마지막으로 조회한 카드 목록은 앱의 로컬 데이터 폴더에 저장합니다. 기본 갱신 주기는 60초이며, 조회 실패 시 마지막 목록과 갱신 실패 상태를 함께 표시합니다. 한 번에 최대 20개를 표시하고 나머지 결과가 있으면 이를 안내합니다.

## 범위

- 캐릭터 자율 이동·드래그, 카드 패널, 빈 영역 클릭 통과
- Codex 로컬 작업의 읽기 전용 상태 구독, 최근 활동, 알림·사운드, 원본 대화 열기
- 기존 Notion 뷰 조회, 수동·주기적 갱신, 원본 페이지 열기
- 카드에서 작업 상태 변경, 저장 성공 후 뷰 필터·정렬 재조회
- 향후 Paca 연결을 위한 Provider 경계

Paca 어댑터, 상태 이외 카드 속성 편집, 다중 모니터 이동, LLM 기능은 후속 범위입니다. Paca는 로컬 호스팅 GTD 도구이며 연결 대상은 기본적으로 사용자가 지정한 서버입니다.

요구사항과 수용 기준은 [기능 명세](docs/spec.md), 모듈·권한 경계와 참고 프로젝트는 [구조 문서](docs/architecture.md)에 정리했습니다. 캐릭터 크기·좌표·상태·애니메이션 설정과 교체 기준은 [캐릭터 리소스와 애니메이션 사양](docs/character-sprites.md)에 정리했습니다. 실제 Notion 계정 연결과 OS 창 동작은 수용 기준에 따라 별도로 검증해야 합니다.

Live2D 등 캐릭터 표현 확장에 필요한 런타임·모델 계약, BongoCat 구조의 재사용 범위와 네이티브 전환 조건은 [표현 계층 전환 검토](docs/presentation-migration.md)에 정리했습니다.

## macOS 자원 측정

M1 Max에서 릴리스 앱을 실행해 유휴·연속 이동·카드 열람을 측정했습니다. [측정 보고서](docs/measurements/2026-11-17-macos/REPORT.md)에 조건, 앱 CPU·GPU 시간, 전력 추정의 한계, 원본 데이터와 재현용 수집 코드를 정리했습니다.
