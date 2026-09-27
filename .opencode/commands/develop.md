---
description: Develop with mandatory code review
temperature: 0.2
---

Develop the requested change. $ARGUMENTS

Before starting, check for relevant project skills and follow them when applicable.

After implementation:
1. Run the relevant tests, type checks, linting, and other project checks.
2. Invoke the `reviewer` agent.
3. If the reviewer returns PASS, finish the task.
4. If the reviewer returns FAIL, fix the reported issues and run the relevant checks again.
5. Invoke the `reviewer` agent again after the fixes.
6. Invoke the reviewer at most 2 times.
7. If the second review returns FAIL, stop and report the remaining issues to the user.

Do not commit or push changes unless explicitly requested.