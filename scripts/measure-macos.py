#!/usr/bin/env python3
"""App-scoped counters + system power, with repeated native LaunchServices runs.

Requires a release .app built with --features measurement, macmon 0.12.0,
and the helper built from macos-process-metrics.c. No privileged operations.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parent.parent
ORDERS = [('idle', 'moving', 'cards'), ('moving', 'cards', 'idle'), ('cards', 'idle', 'moving')]
SYSTEM_FIELDS = ('timestamp', 'cpu_power', 'gpu_power', 'sys_power', 'chip_power',
                 'cpu_active_ratio', 'gpu_active_ratio', 'gpu_scaled_ratio',
                 'battery_percent', 'battery_charging', 'battery_plugged')


def emit(**event):
    print(json.dumps(event, ensure_ascii=False), flush=True)


def command(args):
    return subprocess.check_output([str(arg) for arg in args], text=True).strip()


def read_events(path):
    if not path.exists():
        return []
    result = []
    for line in path.read_text().splitlines():
        try:
            result.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return result


def app_delta(previous, current):
    """Keep counter resets/births visible; absent GPU counters never mean GPU zero."""
    wall = current['monotonic_ns'] - previous['monotonic_ns']
    before = {p['pid']: p for p in previous['processes']}
    after = {p['pid']: p for p in current['processes']}
    issues = []
    if wall <= 0:
        return {'valid': False, 'issues': ['nonpositive_interval']}
    if before.keys() != after.keys():
        issues.append('process_membership_changed')
    cpu = energy = gpu = 0
    cpu_valid = energy_valid = not issues
    gpu_valid = bool(current.get('gpu_scan', {}).get('available')) and bool(previous.get('gpu_scan', {}).get('available'))
    gpu_valid &= current.get('gpu_scan', {}).get('consistent', False) and previous.get('gpu_scan', {}).get('consistent', False)
    gpu_known = False
    for pid in before.keys() & after.keys():
        a, b = before[pid], after[pid]
        if not a.get('readable') or not b.get('readable'):
            issues.append(f'cpu_rusage_unreadable:{pid}')
            cpu_valid = energy_valid = False
        if a.get('process_start_ticks') != b.get('process_start_ticks'):
            issues.append(f'pid_reused:{pid}')
            cpu_valid = energy_valid = gpu_valid = False
            continue
        for key, metric in [('cpu_time_ns', 'cpu'), ('cpu_energy_nj', 'energy')]:
            x, y = a.get(key), b.get(key)
            if x is None or y is None or y < x:
                issues.append(f'{metric}_counter_unavailable_or_reset:{pid}')
                if metric == 'cpu': cpu_valid = False
                else: energy_valid = False
            elif metric == 'cpu': cpu += y - x
            else: energy += y - x
        x, y = a.get('gpu_time_ns'), b.get('gpu_time_ns')
        if x is not None or y is not None:
            gpu_known = True
            if (x is None or y is None or y < x or a.get('gpu_clients') != b.get('gpu_clients')
                    or a.get('gpu_client_ids') != b.get('gpu_client_ids')):
                gpu_valid = False
                issues.append(f'gpu_counter_unavailable_or_reset:{pid}')
            else: gpu += y - x
    gpu_valid &= gpu_known and not ('process_membership_changed' in issues)
    return {
        'valid': cpu_valid, 'issues': issues, 'interval_s': wall / 1e9,
        'app_cpu_percent_one_core': cpu / wall * 100 if cpu_valid else None,
        'app_cpu_energy_w': energy / wall if energy_valid else None,
        'app_gpu_ms_per_s': gpu / wall * 1000 if gpu_valid else None,
        'app_footprint_mib': sum(p.get('physical_footprint_bytes', 0) for p in after.values()) / 2**20,
    }


class Measurement:
    def __init__(self, args):
        self.args = args
        self.output = args.output.resolve()
        self.output.mkdir(parents=True, exist_ok=False)
        self.pid = None
        self.macmon = None
        self.caffeinate = None
        self.records = []
        self.phases = []

    def snapshot(self, pid):
        start = time.monotonic_ns()
        value = json.loads(command([self.args.helper, '--root', pid]))
        return value, (time.monotonic_ns() - start) / 1e6

    def tick(self, after_epoch=None):
        while True:
            line = self.macmon.stdout.readline()
            if not line:
                raise RuntimeError('macmon stopped before the measurement completed')
            value = json.loads(line)
            timestamp = datetime.fromisoformat(value['timestamp']).timestamp()
            if after_epoch is None or timestamp >= after_epoch:
                return value

    def launch(self, state, run):
        log = self.output / f'{run}-{state}-state.jsonl'
        subprocess.run(['/usr/bin/open', '-n', '-g', '--env', f'CARD_CAPTOR_MEASUREMENT_LOG={log}',
                        str(self.args.app), '--args', '--measurement-state', state], check=True)
        expected = {'idle': 'idle', 'moving': 'walk', 'cards': 'browsing'}[state]
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            entries = read_events(log)
            if entries:
                self.pid = entries[-1]['pid']
                if (entries[-1].get('renderer') == 'webgl' and entries[-1].get('mode') == expected
                        and entries[-1].get('visible') is True):
                    snapshot, _ = self.snapshot(self.pid)
                    if not snapshot['root_alive']:
                        raise RuntimeError('measurement application exited during startup')
                    if snapshot['coalition_shared_with_sampler']:
                        raise RuntimeError('application inherited the observer coalition; attribution would be invalid')
                    return log
            time.sleep(.1)
        raise RuntimeError(f'{state}: native WebGL/state readiness not confirmed in {log}')

    def stop_app(self):
        if self.pid is None:
            return
        pid = self.pid
        self.pid = None
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        for _ in range(100):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            time.sleep(.1)
        raise RuntimeError(f'measurement app did not exit: {pid}')

    def capture(self, state, run, log=None):
        emit(event='warmup', state=state, run=run, seconds=self.args.warmup if state != 'closed' else 5)
        # Drop the startup backlog and require a real wall-clock warmup, not N lines.
        warmup_end = time.time() + (self.args.warmup if state != 'closed' else 5)
        self.tick(after_epoch=warmup_end)
        previous, _ = self.snapshot(self.pid or os.getpid())
        start = datetime.now(timezone.utc).isoformat()
        rows = []
        for index in range(self.args.samples):
            system = self.tick()
            snapshot, overhead = self.snapshot(self.pid or os.getpid())
            if self.pid and (not snapshot['root_alive'] or snapshot['coalition_shared_with_sampler']):
                raise RuntimeError('application disappeared or process attribution changed')
            event = read_events(log)[-1] if log else None
            if event and (event.get('visible') is not True or event.get('renderer') != 'webgl'):
                raise RuntimeError('native window became hidden or WebGL was lost during sampling')
            delta = app_delta(previous, snapshot) if self.pid else {
                'valid': True, 'issues': [], 'app_cpu_percent_one_core': 0,
                'app_cpu_energy_w': 0, 'app_gpu_ms_per_s': 0,
            }
            previous = snapshot
            row = {
                'state': state, 'run': run, 'sample': index,
                'captured_at': datetime.now(timezone.utc).isoformat(),
                'system': {key: system.get(key) for key in SYSTEM_FIELDS},
                'app': snapshot if self.pid else None,
                'observer_snapshot_ms': overhead, 'delta': delta, 'state_observation': event,
            }
            self.records.append(row)
            rows.append(row)
            with (self.output / 'raw.jsonl').open('a') as out:
                out.write(json.dumps(row) + '\n')
        phase = {'state': state, 'run': run, 'started_at': start,
                 'ended_at': datetime.now(timezone.utc).isoformat(), 'sample_count': len(rows),
                 'state_log': log.name if log else None,
                 'root_pid': self.pid}
        self.phases.append(phase)
        (self.output / 'phases.json').write_text(json.dumps(self.phases, indent=2))
        emit(event='phase_complete', **phase)

    def run(self):
        existing = subprocess.run(['/usr/bin/pgrep', '-x', 'card-captor'], text=True, capture_output=True)
        if existing.returncode == 0:
            raise RuntimeError('Card Captor is already running; close the existing instance first')
        binary = self.args.app / 'Contents/MacOS/card-captor'
        metadata = {
            'started_at': datetime.now(timezone.utc).isoformat(),
            'app': str(self.args.app), 'binary_sha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
            'build': 'release, Cargo feature measurement', 'samples_per_phase': self.args.samples,
            'warmup_seconds': self.args.warmup, 'orders': ORDERS[:self.args.rounds],
            'cpu': command(['/usr/sbin/sysctl', '-n', 'machdep.cpu.brand_string']),
            'logical_cpus': int(command(['/usr/sbin/sysctl', '-n', 'hw.ncpu'])),
            'memory_bytes': int(command(['/usr/sbin/sysctl', '-n', 'hw.memsize'])),
            'macos': command(['/usr/bin/sw_vers', '-productVersion']),
            'macmon': command([self.args.macmon, '--version']),
            'observer': 'macmon 1Hz plus one app-scoped counter snapshot per second; baseline scans observer group for similar collection work',
            'fixture_cards': 20, 'network': 'Notion disabled; local synthetic cards',
            'sleep_assertion': 'caffeinate -d -i -u -w observer_pid; released on exit; no persistent settings changed',
            'metrics': {
                'app_cpu_percent_one_core': 'sum CPU time / wall time * 100; 100%=one logical CPU',
                'app_cpu_energy_w': 'estimated process CPU energy only, excludes GPU rail and display',
                'app_gpu_ms_per_s': 'sum live app GPU queue execution time / wall time, not GPU core occupancy',
                'sys_power': 'system power estimate; cannot be attributed entirely to the app',
            },
        }
        (self.output / 'metadata.json').write_text(json.dumps(metadata, indent=2))
        stderr = (self.output / 'macmon-stderr.txt').open('w')
        self.macmon = subprocess.Popen([str(self.args.macmon), 'pipe', '--interval', '1000'],
                                       stdout=subprocess.PIPE, stderr=stderr, text=True, bufsize=1)
        self.caffeinate = subprocess.Popen(['/usr/bin/caffeinate', '-d', '-i', '-u', '-w', str(os.getpid())])
        try:
            emit(event='cooldown', seconds=self.args.cooldown)
            self.tick(after_epoch=time.time() + self.args.cooldown)
            self.capture('closed', 0)
            for run, order in enumerate(ORDERS[:self.args.rounds], 1):
                for state in order:
                    log = self.launch(state, run)
                    self.capture(state, run, log)
                    self.stop_app()
                self.capture('closed', run)
        finally:
            self.stop_app()
            self.macmon.terminate()
            self.macmon.wait(timeout=10)
            self.caffeinate.terminate()
            self.caffeinate.wait(timeout=10)
            stderr.close()
        emit(event='complete', output=str(self.output), samples=len(self.records))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, default=ROOT / 'src-tauri/target/release/bundle/macos/Card Captor.app')
    parser.add_argument('--macmon', type=Path, default=ROOT / '.artifacts/tools/macmon')
    parser.add_argument('--helper', type=Path, default=ROOT / '.artifacts/tools/process-metrics')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--samples', type=int, default=30)
    parser.add_argument('--warmup', type=int, default=10)
    parser.add_argument('--cooldown', type=int, default=30)
    parser.add_argument('--rounds', type=int, choices=(1, 2, 3), default=3)
    args = parser.parse_args()
    Measurement(args).run()


if __name__ == '__main__':
    main()
