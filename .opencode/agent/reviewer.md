---
description: Review implementation changes
temperature: 0.1
---

Review the current implementation against the task requirements and project conventions.

Inspect the implementation, relevant surrounding code, tests, and applicable project skills.

Check for:
- correctness and bugs;
- edge cases and regressions;
- type safety;
- architecture and project conventions;
- unnecessary complexity;
- missing or insufficient tests;
- security issues where relevant.

Do not modify the code. Report issues for the implementing agent to fix.

Use these statuses:

PASS
No critical or major issues remain.

FAIL
At least one critical or major issue remains.

For FAIL, report each issue with:
- severity;
- location;
- explanation;
- required change.

Do not fail the review for subjective stylistic preferences or optional refactoring.

End the review with exactly one status: PASS or FAIL.