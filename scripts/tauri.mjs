import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { run } from '@tauri-apps/cli';

// Use an existing toolchain. The task cache is a local fallback, never an installer.
if (spawnSync('cargo', ['--version'], { stdio: 'ignore' }).status !== 0) {
  const executable = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
  const userDirectory = homedir();
  const defaultBin = join(userDirectory, '.cargo', 'bin');
  const taskCache = join(userDirectory, '.cache', 'card-captor');
  const taskBin = join(taskCache, 'cargo', 'bin');
  if (existsSync(join(defaultBin, executable))) {
    process.env.PATH = `${defaultBin}${delimiter}${process.env.PATH ?? ''}`;
  } else if (existsSync(join(taskBin, executable)) && !process.env.CARGO_HOME && !process.env.RUSTUP_HOME) {
    process.env.CARGO_HOME = join(taskCache, 'cargo');
    process.env.RUSTUP_HOME = join(taskCache, 'rustup');
    process.env.PATH = `${taskBin}${delimiter}${process.env.PATH ?? ''}`;
  }
}

try {
  await run(process.argv.slice(2), 'card-captor');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
