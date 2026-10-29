# Review Packet Format

Plain text in ONE code block, also saved to `runs/review_packet.txt`, under about 300 lines, no whole files, no prose summaries, never claim what you did not run.

## Sections

1. **GIT**: `git log --oneline -8`, `git status --short`, `git show --stat --oneline HEAD`.
2. **COMMANDS RUN**: each verification command with its exit code and the last 15 lines of output. Python tests only through WSL (`./env-tools/bin/pytest -q`); npm tests via `npm.cmd test` in `viewer/`.
3. **CHANGED CODE**: per changed file the path and line count, then only the changed functions or cells with file:line ranges.
4. **REQUIREMENT TABLE**: number | requirement | PRESENT/PARTIAL/MISSING | file:line | covering test or "no test".
5. **AUTOMATED CHECKS**: compile every changed .py file and notebook cell; grep changed files for lines ending in a backtick, TODO, mock, fake, synthetic, [U] outside comments, hard-coded absolute paths, "except:" or "except Exception: pass"; `git diff HEAD --stat`.
6. **VERSIONS AND FLAGS**: every tool, package or flag used, marked VERIFIED (with the date and how) or UNVERIFIED [U].
7. **DECISIONS AND DEVIATIONS**: anything you chose or did differently from my instructions, and your assumptions, or "none".
8. **NOT DONE / NOT TESTED**: everything that needs a GPU, a browser, a real video, or me.
9. **NEXT QUESTIONS**: up to 3.
