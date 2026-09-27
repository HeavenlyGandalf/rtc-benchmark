---
description: Разделить изменения working tree на логические коммиты
temperature: 0.3
---

Create a commit plan for the current working tree changes and commit them as separate logical commits. $ARGUMENTS

Before staging, check for a skill covering this project's git conventions/flow and follow it if one exists.

First inspect:
- `git status`
- `git diff`
- `git diff --stat`
- recent `git log` to understand the repository's commit style

Before creating any commit, check the current Git identity:
- `git config user.name`
- `git config user.email`

If the Git identity does not match the expected account for this repository, STOP and ask the user before making any commits.

Analyze the changes and create a commit plan. Each commit must represent one logical change and have a concise English commit message.

The commit plan must be shown to the user before any staging or committing.

Prefer multiple commits when the working tree contains independent logical changes. Do not create one large commit when the changes can be meaningfully separated.

For each planned commit:
1. Stage ONLY the files or hunks belonging to that logical change.
2. Do not use `git add -A`, `git add .`, or blindly stage the entire working tree.
3. Inspect the staged changes with `git diff --cached`.
4. Commit using the planned English commit message.
5. Verify the created commit with `git show --stat --oneline HEAD`.

Commit messages must be concise, descriptive, and written in English.
Do not use Conventional Commits prefixes such as `feat:`, `fix:`, `chore:`, `refactor:`, `docs:`, or `test:`.
Use a natural imperative-style message, for example:
- `Add WebSocket reconnect handling`
- `Extract authentication logic`
- `Update validation tests`

Commit messages must be in English and describe the actual change. Use the repository's existing commit style when one is established.

Do not:
- push changes
- amend existing commits
- reset or discard user changes
- modify unrelated files
- include unrelated changes in a commit
- create empty commits

If a single file contains changes belonging to multiple logical commits, use partial/hunk staging when possible.

After all planned commits are created, show the resulting commits and the final `git status`.

If the changes cannot be safely separated into the planned commits, STOP rather than making an incorrect commit.