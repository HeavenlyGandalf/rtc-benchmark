# Project Overview

This is a WebRTC benchmark project for comparing real-time communication technologies.

The project contains:
- WebRTC client implementation
- WebRTC server implementation
- WebTransport implementation
- Benchmarking and measurement tools


# Tech Stack

Frontend:
- TypeScript
- Browser Web APIs
- WebRTC API

Backend:
- Node.js
- TypeScript

Package manager:
- Yarn


# Architecture Rules

Follow existing project architecture.

Before changing code:
1. Understand the existing implementation.
2. Find related modules and dependencies.
3. Explain the proposed changes before implementation.

Do not introduce new libraries without explaining why they are needed.


# Code Style

General rules:
- Use TypeScript strictly.
- Avoid `any`.
- Prefer explicit types.
- Keep functions small and focused.
- Follow existing naming conventions.

When modifying existing code:
- Minimize unrelated changes.
- Do not refactor code unless it is required for the task.


# WebRTC Rules

When working with WebRTC code:

- Always properly close peer connections.
- Clean up event listeners.
- Handle connection state changes.
- Consider browser compatibility.
- Do not ignore ICE connection failures.

Important WebRTC concepts:
- signaling
- ICE candidates
- STUN/TURN
- RTCPeerConnection lifecycle
- DataChannel lifecycle


# Testing

After code changes:

1. Run type checking.
2. Run tests.
3. Verify that WebRTC connection still works.

If tests are missing:
- suggest adding them.


# Debugging Rules

When investigating bugs:

First:
1. Reproduce the problem.
2. Check logs.
3. Identify the root cause.

Do not apply random fixes.


# Communication Style

When working on tasks:
- Explain the plan before implementation.
- Mention assumptions.
- Report possible risks.
- Summarize changes after completion.

## Code Review

After completing a non-trivial code change, ask the `reviewer`
subagent to review the changes.

The reviewer should inspect the git diff and report issues.

If the reviewer finds Critical or Important issues:
1. Fix the issues.
2. Run the relevant checks.
3. Ask the reviewer to review the changes again.

Do not consider the task complete while Critical issues remain.

## Git Identity

Before creating any commit, always verify the current Git identity.

Run:

git config user.name
git config user.email

Do not create a commit until the identity has been verified.

The expected Git account is:

- user.name: heavygendalf
- user.email: katyaritm@mail.ru

If the configured identity does not match the expected identity:
1. Stop.
2. Do not create the commit.
3. Report the current `user.name` and `user.email`.
4. Ask the user to correct the Git configuration.

COMMIT RULES

Before creating commits:
1. Check `git status` and `git diff`.
2. Check the current Git identity with:
   git config user.name
   git config user.email
3. Verify that the Git identity is the expected account.
4. If the identity is unexpected, STOP and ask the user.

Before committing:
1. Create a commit plan.
2. The plan MUST contain multiple commits when the changes represent multiple logical units.
3. Every commit MUST have an English imperative-style message.
4. Do not create a single large commit if the changes can be separated logically.
5. Show the commit plan before executing commits.

For each planned commit:
1. Stage ONLY files/hunks belonging to that logical change.
2. Review the staged diff with:
   git diff --cached
3. Create the commit.
4. Verify the commit with:
   git show --stat --oneline HEAD

Never:
- commit unrelated changes;
- use `git add .` blindly;
- combine unrelated changes into one commit;
- rewrite existing commits unless explicitly requested;
- push to a remote unless explicitly requested.