import { spawn } from 'child_process'

// Why: every Android command (adb, docker, binder probe) flows through one
// executor so the SAME pure parsers run against local-spawn output and
// remote-over-SSH output. Implementations are injected; nothing here spawns or
// connects at import time, so tests mock the executor with fixture results.
export type AdbCommandResult = {
  stdout: string
  stderr: string
  // POSIX exit code of the program. null when the program could not be spawned
  // at all (local ENOENT) — distinct from a program that ran and exited non-zero
  // (e.g. adb present but the device is offline).
  exitCode: number | null
  // true only when the binary itself could not be resolved/spawned locally.
  spawnError: boolean
}

export type AdbCommandExecutor = {
  readonly mode: 'local' | 'remote'
  // Run `program` with `args`, resolving the binary via PATH. Never throws on a
  // non-zero exit; the result captures stdout/stderr/exitCode for pure parsers.
  exec(program: string, args: string[]): Promise<AdbCommandResult>
}

// Why: injectable spawn keeps the local executor testable and never fires a real
// process during import. The default resolves the binary via PATH — on Windows
// CreateProcess appends `.exe`, so `adb` finds adb.exe — never a hardcoded path.
export type LocalSpawn = (program: string, args: string[]) => Promise<AdbCommandResult>

const defaultLocalSpawn: LocalSpawn = (program, args) =>
  new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    const child = spawn(program, args, { shell: false })
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8')
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      // ENOENT => binary not on PATH; report spawnError so availability maps it
      // to adb/docker_missing rather than a false "ran and failed".
      resolve({ stdout, stderr: stderr || error.message, exitCode: null, spawnError: true })
    })
    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code, spawnError: false })
    })
  })

export function createLocalAdbExecutor(
  spawnImpl: LocalSpawn = defaultLocalSpawn
): AdbCommandExecutor {
  return {
    mode: 'local',
    exec: (program, args) => spawnImpl(program, args)
  }
}

// Remote executor lives in a sibling so the local-spawn + ssh-wrap + parsers stay
// well under the 300-line cap (per the design doc's split note).
export { createRemoteAdbExecutor } from './adb-remote-command'
