#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { constants } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

function emit(event: string, fields: Record<string, unknown>) {
  process.stdout.write(JSON.stringify({ event, ...fields }) + "\n");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function serve(directory: string) {
  mkdirSync(directory, { mode: 0o700 });
  const active = new Set<number>();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let closing = false;

  function closeInput() {
    closing = true;
    input.close();
    process.stdin.destroy();
  }

  function start({ id, argv, cwd }: Record<string, unknown>) {
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
      throw new Error("id must be a filename starting with a letter or digit");
    }
    if (!Array.isArray(argv) || !argv.length || !argv.every(arg => typeof arg === "string")) {
      throw new Error("argv must be a nonempty array of strings");
    }
    if (cwd != null && typeof cwd !== "string") throw new Error("cwd must be a path string");

    const attempt = path.join(directory, id);
    mkdirSync(attempt);
    const stdout = path.join(attempt, "stdout");
    const stderr = path.join(attempt, "stderr");
    const fds: number[] = [];
    try {
      fds.push(openSync(stdout, "w"));
      fds.push(openSync(stderr, "w"));
      const child = spawn(argv[0], argv.slice(1), {
        cwd: cwd ?? undefined, detached: true, stdio: ["ignore", fds[0], fds[1]],
      });
      const pid = child.pid;
      if (pid !== undefined) active.add(pid);
      child.once("spawn", () => emit("started", { id, pid, stdout, stderr }));
      child.once("error", error => emit("rejected", { id, error: error.message }));
      child.once("exit", (code, signal) => {
        if (pid !== undefined) active.delete(pid);
        const returncode = signal ? -constants.signals[signal] : code;
        emit("exited", { id, returncode });
      });
    } finally {
      for (const fd of fds) closeSync(fd);
    }
  }

  input.on("line", line => {
    if (closing) return;
    let id: unknown = null;
    try {
      const request = JSON.parse(line);
      if (!request || typeof request !== "object" || Array.isArray(request)) {
        throw new Error("expected a JSON object");
      }
      if (request.op === "close" && Object.keys(request).length === 1) {
        closeInput();
        return;
      }
      id = request.id ?? null;
      start(request);
    } catch (error) {
      emit("rejected", { id, error: errorMessage(error) });
    }
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      closeInput();
      process.exitCode = 128 + constants.signals[signal];
      for (const pid of active) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
    });
  }
}

const args = process.argv.slice(2);
const usage = "Usage: node wait-any.mts DIRECTORY";
if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
  console.log(usage);
} else if (args.length !== 1) {
  console.error(usage);
  process.exitCode = 2;
} else {
  try {
    serve(path.resolve(args[0]));
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
