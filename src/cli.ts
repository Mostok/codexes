import { runCli } from "./core/bootstrap.js";

const exitCode = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  executablePath: process.argv[1] ?? process.execPath,
  stderr: process.stderr,
  stdout: process.stdout,
});

process.exit(exitCode);
