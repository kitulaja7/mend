# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/kitulaja7/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/kitulaja7/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is a small command-line tool that takes an edit written by an AI model and applies it to a tree of text files. Models write edits in four different shapes — unified diffs (often with the wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and JSON tool calls — and mend reads all four. When the lines do not match exactly, it falls back through three tiers of fuzzy matching (exact, trailing whitespace trimmed, both sides trimmed with re-indentation), so edits with drifted whitespace and indentation still land. Every patch is applied all at once or not at all: if any edit fails, nothing is written. Before anything is written, every edit is checked for safety — bad paths, missing files, and matches that occur more than once are reported one line per failed edit, and a failed patch leaves the tree untouched. It runs on Node 22 using only the standard library — no dependencies.

## Run it

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

The working directory is the root of the file tree. PATCH is the patch file, or `-` (or absent) to read the patch from standard input. `--format` picks one of `unified`, `search-replace`, `v4a`, `json`, or `auto` (the default, which detects the format). `--check` runs everything but writes nothing. `--strict` matches lines exactly. See `SPEC.md` for the full specification.

Built for the make.fun bounty: https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122
