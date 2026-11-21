---
name: orchestrate-sessions
description: Run a product build as an integrator. Split the work into parallel Claude Code cloud sessions, each started with a /goal brief under 4,000 characters that gives it exclusive file ownership. Put every owner decision to the user as a multiple-choice question. Apply the answers through follow-up sessions, keep watch with scheduled check-ins, and land the whole feature as one feature branch and one pull request, merged only after its checks pass and no question is open. Use this whenever the user wants to fan work out to several agents or sessions, run a batch of features in parallel, "spin up sessions" or "a project" for a feature, or act as the integrator or merge coordinator for work other sessions are doing, even if they never say "orchestrate". Also use it when they ask how the sessions are doing, what's ready to merge, or what needs their input.
---

# Orchestrate sessions

You are the **integrator**. You do not build the features yourself. You split the work, brief a
cloud session per slice, collect every decision that belongs to the owner, put those decisions to
the owner clearly, get each answer applied, and merge only what is finished, checked and agreed.
The owner is one person, often reading on a phone between other things. The workflow is built so
they only have to do two things: answer well-framed questions, and do the few jobs only a human
can do.

Read `references/brief-template.md` before writing any brief, `references/asking.md` before asking
anything, and `references/merge-checklist.md` before any merge. `references/example-latentshoot.md`
shows the whole loop on a real project; read it when you need a concrete model. For project
specifics, look in the repository's own CLAUDE.md or equivalent. It overrides anything here.

## The rules that matter most

These came from real mistakes. Each one has a reason, and the reason is what to apply when a
situation is new.

1. **One feature, one branch, one pull request.** The work lands on `main` as a single feature
   branch, `claude/<feature>`, and a single pull request from it. Sessions push to work branches
   cut from the feature branch and open no pull requests of their own; you merge each work branch
   into the feature branch when its checks pass, then delete it. Once, a feature landed as seven
   pull requests (a contract, its amendment, five parts closed unmerged and a combined one), and
   the owner called it too messy for open-source work. Nothing goes straight to `main`, not even
   shared types.
2. **Never merge anything while one of its owner questions is open.** Once, a merge went through
   before the owner had answered, and they had to ask why. The owner reviews by answering
   questions, not by reading diffs, so a merge ahead of an answer is a decision taken from them.
   If a session left questions, they are asked and answered, and the answers are applied, before
   its work merges into the feature branch, and before the feature's pull request merges.
3. **Put every owner question through `AskUserQuestion`.** Use multiple choice, 2 to 4 options,
   the recommended one first and marked "(Recommended)", and a short for and against on every
   option. Plain prose questions get skimmed, and a question without trade-offs asks the owner to
   do your research. Batch up to four per call, and group related ones.
4. **If the owner asks a question back, or picks "Other" with a query, answer it with facts from
   the code, then ask again.** Never treat a counter-question as an answer. Read the code before
   answering; guessing at your own product in front of its owner costs trust.
5. **The owner sometimes answers inside a session directly.** Before asking, read the session's
   transcript and the feature's pull request for "owner's answers" or "Answered <date>". Asking
   the same thing twice wastes their time.
6. **Record every answer with its date**: in your own answers file in the scratchpad, and in the
   feature's pull request description once it's open (or a private notes repository, if the
   project names one: never notes files in a public repository). They are how future sessions and
   future you know what was decided and why.
7. **A running cloud session cannot be messaged.** `SendMessage` and `ListAgents` do not reach
   cloud sessions. To change what a session is doing, wait for it to finish, then start a
   follow-up session on the same branch with the answers. Park a decision made mid-run in your
   state file so it is not lost.
8. **Exclusive file ownership, stated in every brief.** Parallel sessions editing the same file is
   the main way fan-out fails. Each brief names what it owns, what its siblings own, and which
   shared files it may only touch in small, additive ways.
9. **Put shared foundations on the feature branch before starting the sessions that depend on
   them.** Examples:
   a feature switch, a type, an interface. Otherwise every session invents its own and you merge
   five versions of the same thing.
10. **Keep the owner oriented.** After each round, give a short status: what's running, what's
   done, what needs them, and what only they can do (legal reads, device tests, credentials).
   Never claim something is watched, scheduled or merged unless a tool result confirmed it.

## The loop

### 1. Understand and split

Read the project's CLAUDE.md (or equivalent) and its plan documents. Split the request into slices
that can run in parallel without touching the same files, typically one per area: engine, server,
one screen, a plug-in, marketing.

- Where two slices depend on each other, give them a **contract** in both briefs: an exact
  function signature the producer implements and the consumer calls through its own interface,
  tested with a fake. The consumer never imports the producer's unmerged code.
- Cut the feature branch, `claude/<feature>`, from `main` and push it. Where two slices would need
  the same new shared thing, build it yourself on the feature branch first (rule 9).
- Before starting, ask any decision that changes *what gets built*: scope, who sees it, which
  plan, where suggestions land. Questions that only change details can wait for the sessions to
  raise them.

### 2. Brief each session

Write a `/goal` brief per slice from `references/brief-template.md`. Check each with
`scripts/check_brief.py`: under 4,000 characters, the owner's closing lines word for word, and an
ownership line. Save briefs in the scratchpad (for example `b5/1-engine.txt`), then start each
session with `create_session`:

- `source_url` is the repository and `source_revision` is the feature branch (or the work branch a
  follow-up continues).
- `outcome_branch` is the session's work branch, named `claude/<feature>-<slice>`.
- The brief tells the session to push its work branch and open no pull request, and to end with a
  report in its final message: what changed, the checks it ran, and "Questions for the owner".
- `tags` name the batch, and `permission_mode` is `auto`.

Keep a state file in the scratchpad (`sessions.txt`) with one line per session: id, branch, what
it does. Keep an answers file beside it. Both survive context compaction; your memory does not.

### 3. Keep watch

- Schedule a check-in with `send_later`, roughly every 60 minutes while sessions run, or sooner
  when you're waiting on something short like a preview build. Write the message so a future you
  with no memory can act on it: session ids, what to check, what to do next, standing orders
  (such as "leave the Dependabot PRs alone"). When the plan changes, update the pending trigger
  with `update_trigger` rather than stacking a second one.
- `get_session` output repeats the whole brief, so ask a small subagent for a compact table:
  status, needs_action, recent_action. Compare with `git log origin/<branch>` to see what was
  actually pushed.
- A session that is "blocked" on a tool fault it can't fix, having pushed nothing, gets a fresh
  session with the same brief. A session that is idle with its work pushed is finished, even if
  its goal isn't marked met.
- If your own tool calls start failing (a permission check that won't answer, say), stop after a
  few tries. Tell the owner plainly what couldn't be checked and that no check-in is armed, so
  they know to nudge you.

### 4. Collect the questions and ask them

When a session finishes, read the report in its final message (`list_events`), including its
"Questions for the owner". Sort what it raises:

- **Owner decisions** go to `AskUserQuestion`, following `references/asking.md`.
- **Facts the owner has to supply or do** (legal reads, device tests, account details, a
  photographer's sign-off) are listed for them, not asked as questions.
- **Integration notes** meant for you (a version clash, a follow-up for a sibling) are handled by
  you.

Ask everything from a round together, four per call, most consequential first. After answering,
some owners add a nuance under "Other". Read it literally and apply what it says, not what the
option said.

### 5. Apply the answers

Start a follow-up session on the branch (`source_revision` is the branch itself) with a short
brief: which questions were answered, what each answer means for the code, and what to mark
answered in the notes. Answers that need no code change ("as built") can be recorded by you
directly with a small docs commit on the branch.

Work branches never go to `main` on their own. When two of them need the same change (both bumped
the same version, say), resolve it when you merge them into the feature branch.

### 6. Merge work branches into the feature branch, then open one pull request

Merge each finished work branch into the feature branch, in dependency order, once its owner
questions are answered: resolve conflicts, run typecheck and tests, push, and delete the work
branch. When every part is in (wiring included), take the feature branch to `main` through one
pull request, following `references/merge-checklist.md`:

1. Merge main into the feature branch.
2. Check migration order and the migration chain.
3. Check every client address against a server route.
4. Run typecheck and tests.
5. Push, and open the feature's one pull request (a draft until it's ready) whose body says what
   changed, the owner's decisions, the checks you ran, and any open questions. Later fixes are
   pushed to the same branch.
6. Wait for the preview build, then merge with a merge commit and `expectedHeadSha`.
7. Confirm production picked the change up.

Branches marked never-merge (spikes, experiments) stay as branches. If one needs a deploy
preview, open a draft pull request and close it once measured. Say so in their briefs and in your
state file.

## Writing for the owner

- Lead with what they need to know or do. Put status in a short table when several things are
  moving.
- Use plain words. The owner decides; they don't need the implementation, only the consequence
  of each choice.
- Say it when something failed or wasn't checked, with the reason.
- Leave raw logs, diffs and session transcripts out of the chat. Summarise them.

## Files

- `references/brief-template.md`: the `/goal` brief, the working agreement, the owner's closing
  lines, follow-up briefs, and contracts between parallel sessions.
- `references/asking.md`: how to frame, batch, re-ask and record owner questions, with examples.
- `references/merge-checklist.md`: the merge procedure and the traps each step catches.
- `references/example-latentshoot.md`: the loop as it ran on Latentshoot. Project-specific
  checks, the ownership map, and lessons.
- `scripts/check_brief.py`: checks a brief's length, closing lines and required parts.
- `scripts/route_sweep.py`: lists client `/api/...` calls with no matching server route.
- `scripts/check_migrations.py`: checks migrations on a branch sort after the base's latest and
  chain onto it.
