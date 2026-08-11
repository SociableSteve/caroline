/**
 * The entry point of `npm run delete-data`. Everything it does is in `delete-command.ts`, which is
 * where a test can drive it without a subprocess.
 *
 * The code is set rather than passed to `process.exit`, because exiting immediately after writing to
 * a pipe drops whatever has not been flushed, and the output of this command is the record of what
 * it deleted.
 */
import { runDeleteCommand } from './delete-command.js'

process.exitCode = runDeleteCommand(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
})
