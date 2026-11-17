#!/usr/bin/env python3
"""Recalculate summary/CSV/figure from measure-macos.py raw data.

uv run --with matplotlib==3.11.2 python scripts/summarize-macos.py DATA_DIRECTORY
"""
import argparse
import csv
import json
from pathlib import Path
import statistics

METRICS = {
    'app_cpu_percent': ('delta', 'app_cpu_percent_one_core', 1, True, '% of one logical CPU'),
    'app_gpu_ms_per_s': ('delta', 'app_gpu_ms_per_s', 1, True, 'GPU queue execution ms / wall second'),
    'app_cpu_energy_mw': ('delta', 'app_cpu_energy_w', 1000, True, 'estimated dynamic CPU energy mW'),
    'system_power_w': ('system', 'sys_power', 1, False, 'system power estimate W'),
    'system_cpu_power_w': ('system', 'cpu_power', 1, False, 'system CPU power estimate W'),
    'system_gpu_power_w': ('system', 'gpu_power', 1, False, 'system GPU power estimate W'),
    'system_gpu_active_percent': ('system', 'gpu_active_ratio', 100, False, 'system GPU active time %'),
}


def summarize(rows):
    states = {}
    for state in ('closed', 'idle', 'moving', 'cards'):
        selected = [r for r in rows if r['state'] == state]
        metrics = {}
        for name, (section, key, factor, weighted, unit) in METRICS.items():
            runs = []
            for run in sorted({r['run'] for r in selected}):
                samples = [r for r in selected if r['run'] == run and r[section].get(key) is not None]
                weights = [r['delta'].get('interval_s', 1) if weighted else 1 for r in samples]
                value = sum(r[section][key] * factor * w for r, w in zip(samples, weights)) / sum(weights) if weights else None
                runs.append({'run': run, 'mean': value, 'samples': len(samples)})
            values = [r['mean'] for r in runs if r['mean'] is not None]
            metrics[name] = {'unit': unit, 'time_weighted': weighted, 'runs': runs,
                             'median': statistics.median(values) if values else None,
                             'min': min(values) if values else None,
                             'max': max(values) if values else None}
        states[state] = {'samples': len(selected), 'metrics': metrics}
    app_rows = [r for r in rows if r.get('app')]
    quality = {
        'total_samples': len(rows), 'app_samples': len(app_rows),
        'cpu_invalid_samples': sum(not r['delta']['valid'] for r in app_rows),
        'gpu_unavailable_samples': sum(r['delta'].get('app_gpu_ms_per_s') is None for r in app_rows),
        'unreadable_process_snapshots': sum(not p['readable'] for r in app_rows for p in r['app']['processes']),
        'gpu_incomplete_coverage_samples': sum(any(p['gpu_clients'] != p['gpu_usage_clients'] for p in r['app']['processes']) for r in app_rows),
        'shared_observer_coalition_samples': sum(r['app']['coalition_shared_with_sampler'] for r in app_rows),
        'wrong_native_state_samples': sum(r['state_observation']['mode'] != {'idle': 'idle', 'moving': 'walk', 'cards': 'browsing'}[r['state']] for r in app_rows),
        'hidden_or_non_webgl_samples': sum(not r['state_observation']['visible'] or r['state_observation']['renderer'] != 'webgl' for r in app_rows),
        'near_pointer_samples': sum(r['state_observation']['pointerPollMs'] == 50 for r in app_rows),
        'far_pointer_samples': sum(r['state_observation']['pointerPollMs'] == 250 for r in app_rows),
        'observer_snapshot_wall_ms_mean': statistics.mean(r['observer_snapshot_ms'] for r in rows),
        'battery_percent_start': rows[0]['system']['battery_percent'],
        'battery_percent_end': rows[-1]['system']['battery_percent'],
    }
    return {'aggregation': 'Within-run app rates are weighted by measured wall intervals; 1Hz system samples use arithmetic means. Across runs report median and min/max; no independent-sample confidence intervals.',
            'states': states, 'quality': quality}


def write_csv(directory, rows):
    columns = ['state', 'run', 'sample', 'captured_at', *METRICS, 'pointer_poll_ms', 'observer_snapshot_wall_ms']
    with (directory / 'samples.csv').open('w', newline='') as stream:
        writer = csv.DictWriter(stream, fieldnames=columns)
        writer.writeheader()
        for row in rows:
            result = {key: row[key] for key in ('state', 'run', 'sample', 'captured_at')}
            for name, (section, key, factor, _, _) in METRICS.items():
                value = row[section].get(key)
                result[name] = value * factor if value is not None else None
            result['pointer_poll_ms'] = (row.get('state_observation') or {}).get('pointerPollMs')
            result['observer_snapshot_wall_ms'] = row['observer_snapshot_ms']
            writer.writerow(result)


def plot(directory, rows, summary):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from matplotlib import font_manager
    from datetime import datetime

    font_path = Path('/System/Library/Fonts/Supplemental/AppleGothic.ttf')
    korean = font_path.exists()
    if korean:
        font_manager.fontManager.addfont(str(font_path))
    choose = lambda ko, en: ko if korean else en
    labels = [choose('유휴', 'Idle'), choose('이동', 'Moving'), choose('카드 열람', 'Cards open')]
    names = ['idle', 'moving', 'cards']
    colors = ['#587b86', '#c17c48', '#64856d']
    plt.rcParams.update({'font.family': font_manager.FontProperties(fname=str(font_path)).get_name() if korean else 'DejaVu Sans', 'font.size': 10,
                         'axes.spines.top': False, 'axes.spines.right': False,
                         'axes.titleweight': 'normal', 'svg.fonttype': 'none'})
    fig, axes = plt.subplots(2, 2, figsize=(12.5, 7.8), layout='constrained')
    specs = [('app_cpu_percent', choose('앱 프로세스 그룹 CPU', 'App process group CPU'), choose('CPU % (100% = 논리 코어 하나)', '100% = one logical CPU')),
             ('app_gpu_ms_per_s', choose('앱 GPU 큐 실행시간', 'App GPU queue execution'), choose('ms/s (GPU 코어 점유율과 다름)', 'ms per wall second (not GPU occupancy)')),
             ('app_cpu_energy_mw', choose('CPU 동적 에너지 모델 추정', 'Estimated dynamic CPU energy'), choose('mW (GPU·디스플레이·합성 비용 제외)', 'mW; excludes GPU rail / display / compositor'))]
    for ax, (metric, title, ylabel) in zip(axes.flat, specs):
        entries = [summary['states'][name]['metrics'][metric] for name in names]
        medians = [entry['median'] for entry in entries]
        ax.bar(labels, medians, color=colors, width=.55, alpha=.85)
        for i, entry in enumerate(entries):
            values = [run['mean'] for run in entry['runs']]
            ax.errorbar(i, entry['median'], yerr=[[entry['median'] - entry['min']], [entry['max'] - entry['median']]], color='#26353a', capsize=5, linewidth=1.3)
            ax.scatter([i - .10, i, i + .10], values, color='#26353a', s=25, zorder=3)
            ax.annotate(f"{entry['median']:.2f}", (i, max(values)), xytext=(0, 8), textcoords='offset points', ha='center', weight='semibold')
        ax.set(title=title, ylabel=ylabel)
        ax.set_ylim(0, max(max(entry['max'] for entry in entries) * 1.25, .1))
        ax.grid(axis='y', alpha=.18)
        ax.set_axisbelow(True)
    ax = axes.flat[3]
    first = datetime.fromisoformat(rows[0]['captured_at']).timestamp()
    x = [(datetime.fromisoformat(r['captured_at']).timestamp() - first) / 60 for r in rows]
    ax.plot(x, [r['system']['sys_power'] for r in rows], color='#9aa1a4', linewidth=.8, alpha=.6)
    for name, label, color in [('closed', choose('앱 종료', 'App closed'), '#9aa1a4'), *zip(names, labels, colors)]:
        pairs = [(t, r['system']['sys_power']) for t, r in zip(x, rows) if r['state'] == name]
        ax.scatter([p[0] for p in pairs], [p[1] for p in pairs], s=9, color=color, label=label, alpha=.8)
    ax.set(title=choose('시스템 전체 전력의 배경 변동', 'Whole-system power: background drift'), xlabel=choose('첫 기준선 이후 경과시간 (분)', 'Minutes since first baseline sample'), ylabel=choose('W (앱에만 귀속할 수 없음)', 'W; NOT attributable solely to Card Captor'))
    ax.grid(alpha=.18)
    ax.legend(frameon=False, ncols=2, fontsize=8)
    fig.suptitle(choose('Card Captor · macOS 릴리스 앱 · Apple M1 Max\n상태별 30초 × 3회 · 막대: 중앙값 / 점: 회차 평균 / 선: 회차 범위', 'Card Captor · native macOS release · Apple M1 Max\n30-second runs × 3 per state · median, run means and run range'), fontsize=14)
    fig.savefig(directory / 'measurement.png', dpi=180)
    fig.savefig(directory / 'measurement.svg')
    plt.close(fig)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    rows = [json.loads(line) for line in (args.directory / 'raw.jsonl').read_text().splitlines()]
    result = summarize(rows)
    (args.directory / 'summary.json').write_text(json.dumps(result, indent=2))
    write_csv(args.directory, rows)
    plot(args.directory, rows, result)
    print(json.dumps(result['quality'], indent=2))


if __name__ == '__main__':
    main()
