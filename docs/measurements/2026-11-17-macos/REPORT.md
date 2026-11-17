# macOS 실제 실행 측정

Git 보관본의 앱 절대 경로는 개인 홈 경로 대신 `$PROJECT_ROOT` 접두사로 정규화했다. 연결된 중단 실행 자료에도 같은 처리를 적용했으며, 측정값과 바이너리·소스 해시는 변경하지 않았다.

이동 상태의 앱 CPU 시간은 유휴의 **7.33배**였다. 앱 GPU 큐 실행시간은 이동 시 **9.720ms/s**, 유휴 시 **0.102ms/s**, 정적인 카드 열람 시 **0ms/s**였다. 유휴·열람에서는 지속적인 GPU 렌더링이 거의 관측되지 않았다.

**앱 전체의 추가 소비전력(W)은 이번 결과로 확정할 수 없다.** 앱을 닫은 기준선부터 약 10W 변동했다. 아래의 앱 CPU 에너지는 CPU 모델 추정치이며, 시스템 전력과 구분해야 한다.

## 환경과 측정 대상

| 항목 | 조건 |
|---|---|
| 장치 | Apple M1 Max, 논리 CPU 10개, 메모리 32GB |
| 운영체제 | macOS 27.2.1 |
| 전원 | 배터리 구동, 측정 중 81% → 79%, 충전기 분리 |
| 측정 시각 | 2026-11-17 17:00:00–17:08:26, Asia/Seoul |
| 앱 | 네이티브 Tauri `.app`, release 빌드, Cargo `measurement` feature |
| 렌더러 | PixiJS WebGL, 모든 앱 표본에서 WebGL·창 표시·요구 상태 확인 |
| 콘텐츠 | 동일한 로컬 합성 카드 20개, Notion 통신·연결 설정·외부 동작 비활성화 |
| 계측 | macmon 0.12.0 시스템 계측 + 앱 프로세스 그룹 카운터, 약 1Hz |

실제 릴리스 번들의 CSP를 유지한 상태에서 실행했다. `script-src 'self'`를 사용하며 `unsafe-eval`을 허용하지 않는다. 측정 전용 설정은 상태와 합성 데이터를 고정하고, 실제 캐릭터 렌더러·이동·카드 패널을 실행한다. 빌드 식별용 SHA-256은 [metadata.json](metadata.json)에 기록했다.

## 절차

각 앱 상태를 별도 실행하고 **10초 준비 후 30초 수집**, 상태별 3회 반복했다. 순서는 다음과 같이 교차 배치했다.

| 회차 | 첫 상태 | 두 번째 상태 | 세 번째 상태 |
|---|---|---|---|
| 1 | 유휴 | 이동 | 카드 열람 |
| 2 | 이동 | 카드 열람 | 유휴 |
| 3 | 카드 열람 | 유휴 | 이동 |

- 유휴: 이동을 멈추고 패널을 닫음. 정상 눈깜빡임은 유지.
- 이동: 일반 이동 경로와 최대 30FPS 정책으로 계속 이동. 중간 유휴 대기 제거.
- 카드 열람: 패널을 연 정적 화면. 스크롤·클릭·새로고침 없음.
- 앱을 닫은 30초 기준선은 최초 및 매 회차 종료 후 총 4회 수집. 기준선 준비 시간은 5초.
- 포인터 거리에 따른 폴링은 모든 앱 표본에서 원거리 **250ms**였다. 근거리 50ms 조건은 측정하지 않았다.
- 백그라운드 앱을 강제 종료하거나 디스플레이·전원 설정을 변경하지 않았다.

총 390표본 중 앱 상태 270표본, 닫힘 기준선 120표본이다. 앱 카운터 수집의 평균 경과시간은 표본당 **14.594ms**, 기준선은 **12.955ms**였다. 기준선에서도 관측기 프로세스 그룹을 읽어 유사한 수집 작업을 수행했으며, 계측 오버헤드는 측정값에 포함된다.

임시 `caffeinate` assertion으로 수집 중 화면·유휴 절전을 막았다. 측정 종료 후 앱, 계측기, 임시 assertion의 종료를 확인했으며 영구 설정 변경은 없다. [중단된 최초 실행](../2026-11-17-macos-interrupted/)은 아래 집계에서 제외했다.

## 앱 프로세스 그룹 결과

표기: **회차 평균의 중앙값 [최소–최대]**. 회차 평균은 실제 계측 간격으로 가중했다. 3회 반복의 범위이며 신뢰구간이 아니다.

| 상태 | CPU (%) | GPU 큐 실행시간 (ms/s) | CPU 에너지 추정 (mW) |
|---|---:|---:|---:|
| 유휴 | 3.177 [2.004–3.185] | 0.102 [0.100–0.136] | 2.815 [2.253–2.942] |
| 이동 | 23.297 [15.758–23.548] | 9.720 [9.565–9.768] | 16.353 [13.291–16.741] |
| 카드 열람 | 2.718 [2.463–2.801] | 0.000 [0.000–0.000] | 2.502 [2.470–2.655] |

CPU 100%는 논리 코어 하나의 CPU 시간이다. GPU의 ms/s는 앱에 귀속된 GPU 큐 실행시간이며 GPU 코어 점유율이 아니다. 카드 열람의 0은 해당 구간의 앱 GPU 카운터 증가가 없었다는 뜻이다. 화면 합성 비용까지 0이라는 의미는 아니다.

앱 그룹에는 본체와 WebKit WebContent·GPU·Networking 등 같은 resource coalition에 속하고 본체를 responsible PID로 갖는 프로세스를 포함했다. 전역 WindowServer의 비용은 앱 그룹에 포함하지 않았다.

## 시스템 원시 관측값

각 1Hz 표본을 회차별 평균한 뒤 중앙값과 회차 범위를 표시했다. 앱 상태는 3회, 닫힘은 4회다. 이 표의 전력·GPU active 값은 **장치 전체**에 해당한다.

| 상태 | 시스템 전력 (W) | CPU 전력 (W) | GPU 전력 (W) | GPU active (%) |
|---|---:|---:|---:|---:|
| 유휴 | 10.681 [10.135–20.824] | 1.011 [0.822–5.869] | 0.322 [0.314–0.331] | 25.926 [23.544–26.767] |
| 이동 | 12.617 [12.351–22.681] | 0.973 [0.837–6.013] | 0.450 [0.416–0.453] | 40.186 [40.025–42.674] |
| 카드 열람 | 10.468 [9.684–15.770] | 0.892 [0.814–3.661] | 0.300 [0.298–0.301] | 24.812 [24.662–25.012] |
| 앱 닫힘 | 10.571 [10.204–21.087] | 0.798 [0.739–6.068] | 0.500 [0.439–0.559] | 26.952 [26.053–27.745] |

닫힘 기준선의 시스템 전력 평균은 시간순으로 **10.204 → 10.499 → 10.642 → 21.087W**였다. 마지막 두 기준선 사이에 약 **10.445W** 차이가 있고, 3회차 유휴·이동의 시스템 전력도 함께 높아졌다. 백그라운드 부하를 통제하지 않은 조건의 변동이므로 특정 원인을 단정할 수 없다.

이 변동은 관측된 상태 차이보다 크다. 따라서 상태별 시스템 전력의 단순 차감이나 앞뒤 기준선 보간으로 앱의 추가 W를 주장하지 않는다. CPU·GPU 전력도 macmon의 장치 전력 추정치이며 외부 전력계 실측값이 아니다. GPU active는 macmon의 활성 시간 비율로, 앱 GPU 시간이나 GPU 코어 점유율과 서로 다른 지표다.

## 지표와 검증 범위

| 지표 | 계산·출처 | 해석 범위 |
|---|---|---|
| 앱 CPU | `proc_pid_rusage`의 user+system 시간 차이 ÷ 경과시간 × 100 | Mach tick을 `mach_timebase_info`로 ns 변환. 이 장치의 비율은 125/3 |
| 앱 CPU 에너지 | `ri_energy_nj` 차이 ÷ 경과 ns | nJ/ns = W. CPU 동적 에너지 모델 추정이며 GPU rail·디스플레이·WindowServer 제외 |
| 앱 GPU | IOAccelerator client의 `AppUsage[].accumulatedGPUTime` 차이 ÷ 경과 ns × 1000 | ns 누적 큐 실행시간을 ms/s로 환산 |
| 앱 귀속 | resource coalition + responsible PID | WebKit XPC 프로세스는 PPID만으로 귀속하지 않음 |
| 시스템 전력·GPU active | macmon 0.12.0 | 백그라운드 작업·계측기·화면 합성을 포함한 장치 관측값 |

GPU 속성 및 coalition 정보는 비공개·비안정 인터페이스에 의존하므로 macOS나 하드웨어가 바뀌면 다시 검증해야 한다. macmon과 커널의 에너지 모델도 측정기의 정확도를 보증하지 않는다. CPU 에너지 수치를 앱 전체 전력으로 확장하거나 CPU 비율에 TDP를 곱해 W로 환산하지 않는다.

데이터 품질 검증 결과:

- 앱 270표본 모두 정확한 상태·`visible=true`·WebGL. 상태 로그도 각 30초 수집 구간 전체에서 일치.
- 프로세스 카운터 1,620회 읽기 모두 성공. 앱과 관측기 coalition 분리 확인.
- 모든 GPU client에서 usage coverage 완전. 구간 내 client ID 변경, PID 재사용, 카운터 초기화, 프로세스 구성 변경 없음.
- 앱 계측 간격 0.974–1.022초. 저장된 인접 표본으로 재계산 가능한 261구간의 CPU·GPU·에너지 delta가 원본 집계와 일치.
- CPU 시간의 Mach tick 변환은 별도 `ps` CPU 시간과 대조해 확인.

결과는 한 장치의 짧은 정적·이동 부하 측정이다. 실제 Notion 요청·동기화, 카드 스크롤·조작, 근거리 포인터 폴링, 장시간 배터리 사용, 다른 캐릭터 모델·다른 장치의 비용을 포함하지 않는다.

## 재현

저장소 루트에서 실행한다. 프로젝트 개발 도구와 macmon 0.12.0이 필요하다. macmon 실행 파일의 기본 경로는 `.artifacts/tools/macmon`이며, 다른 경로는 수집 스크립트의 `--macmon`으로 지정할 수 있다. 출력 디렉터리는 기존 파일을 덮어쓰지 않도록 아직 없는 경로를 사용한다.

```sh
mkdir -p .artifacts/tools
clang -O2 -Wall -Wextra scripts/macos-process-metrics.c \
  -framework IOKit -framework CoreFoundation -o .artifacts/tools/process-metrics
pnpm desktop:build --features measurement
python3 scripts/measure-macos.py --output .artifacts/macos-measurement-rerun
uv run --with matplotlib==3.11.2 python scripts/summarize-macos.py \
  .artifacts/macos-measurement-rerun
```

위 절차는 측정용 feature를 활성화한다. 일반 앱 번들은 `pnpm desktop:build`로 다시 빌드한다. 기존 원본으로 집계만 재생성할 때는 마지막 명령의 경로를 `docs/measurements/2026-11-17-macos`로 지정한다.

## 산출물과 근거

- [요약 그래프](measurement.png)
- [집계 JSON](summary.json) · [표본 CSV](samples.csv)
- [원본 JSONL](raw.jsonl) · [환경·빌드 정보](metadata.json) · [수집 구간](phases.json)
- [수집 스크립트](../../../scripts/measure-macos.py) · [프로세스 카운터 구현](../../../scripts/macos-process-metrics.c)

지표 구현 근거는 [macmon v0.12.0 프로세스 계측](https://github.com/vladkens/macmon/blob/v0.12.0/src/app/procs.rs), [macmon v0.12.0 시스템 지표](https://github.com/vladkens/macmon/blob/v0.12.0/src/metrics.rs)를 참고했다. CPU 시간·에너지 단위는 Apple XNU의 [rusage 필드 전달](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/bsd_kern.c), [task 시간·에너지 누적](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/task.c), [CPU 에너지 계수](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/recount.c), [rusage syscall 반환](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_resource.c)에 근거했다.
