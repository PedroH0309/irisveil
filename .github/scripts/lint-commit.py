#!/usr/bin/env python3
"""Check commit messages against the Complete Commit Contract.

Usage:
  python3 scripts/lint-commit.py MESSAGE_FILE        # e.g. as a commit-msg hook
  git log -1 --format=%B | python3 scripts/lint-commit.py -
  python3 scripts/lint-commit.py --range origin/main..HEAD

Options:
  --trailer LINE   exact co-author trailer the repository uses
  --human          do not require a co-author (any present must still match)
  --types LIST     comma-separated allowed types (default: commitlint's 11)
  --json           print machine-readable results

Exit status: 0 no errors, 1 errors found, 2 usage error.
Python 3.9+ standard library only. Reads files, stdin, or `git log`; never writes.
"""

import argparse
import json
import re
import subprocess
import sys

DEFAULT_TYPES = ("build", "chore", "ci", "docs", "feat", "fix", "perf", "refactor", "revert", "style", "test")
HEADER = re.compile(r"^(?P<type>[a-z]+)(?:\((?P<scope>[^()]*)\))?(?P<bang>!)?: (?P<subject>.*)$")
SCOPE = re.compile(r"^[a-z0-9@][a-z0-9._/@-]*$")
EMOJI_PREFIX = re.compile(r"^(?::[a-z0-9_+-]+:|[^\x00-\x7f]+)\s*")
TRAILER = re.compile(r"^(?P<key>[A-Za-z][A-Za-z0-9-]*|BREAKING CHANGE): (?P<value>.+)$")
CO_AUTHOR = re.compile(r"^Co-Authored-By: [^<>]+ <[^<>@\s]+@[^<>\s]+>$")
VAGUE = {"update", "updates", "fix", "fixes", "changes", "change", "misc", "stuff", "wip", "tweak", "tweaks", "cleanup", "minor"}
SCISSORS = "# ------------------------ >8 ------------------------"

HEADER_MAX, SUBJECT_TARGET, SUBJECT_MIN = 72, 50, 10
BODY_MIN_CHARS, BODY_WRAP, BODY_LINE_MAX, BODY_LINES_MAX = 40, 72, 100, 25
BREAKING_MIN = 20


def clean(message):
    lines = []
    for line in message.replace("\r\n", "\n").split("\n"):
        if line.startswith(SCISSORS):
            break
        if not line.startswith("#"):
            lines.append(line.rstrip())
    while lines and not lines[-1]:
        lines.pop()
    while lines and not lines[0]:
        lines.pop(0)
    return lines


def paragraphs(lines):
    blocks, current = [], []
    for line in lines:
        if line:
            current.append(line)
        elif current:
            blocks.append(current)
            current = []
    if current:
        blocks.append(current)
    return blocks


def is_trailer_block(block):
    return all(TRAILER.match(line) or line.startswith((" ", "\t")) for line in block)


def lint(message, types=DEFAULT_TYPES, trailer=None, human=False):
    """Return (errors, warnings) as lists of (rule, text)."""
    errors, warnings = [], []
    lines = clean(message)
    if not lines:
        return [("message-empty", "commit message is empty")], warnings
    header = lines[0]
    if header.startswith(("Merge ", "Revert \"")):
        return errors, [("generated-message", "git-generated merge/revert message; checks skipped")]

    match = HEADER.match(header)
    if not match:
        errors.append(("header-format", "header must be 'type(scope): subject' with one space after the colon"))
        return errors, warnings
    kind, scope, bang, subject = match.group("type", "scope", "bang", "subject")
    if kind not in types:
        errors.append(("type-enum", "type {!r} is not one of: {}".format(kind, ", ".join(types))))
    if not scope:
        errors.append(("scope-empty", "scope is required; name the area that changed, e.g. feat(auth): ..."))
    elif not SCOPE.match(scope):
        errors.append(("scope-case", "scope {!r} must be lower-case kebab-case (package paths and @ allowed)".format(scope)))
    if len(header) > HEADER_MAX:
        errors.append(("header-max-length", "header is {} characters; the limit is {}".format(len(header), HEADER_MAX)))
    text = EMOJI_PREFIX.sub("", subject).strip()
    if len(text) < SUBJECT_MIN:
        errors.append(("subject-min-length", "subject {!r} is too short to describe the change".format(text)))
    elif len(text) > SUBJECT_TARGET:
        warnings.append(("subject-length", "subject is {} characters; aim for {} or fewer".format(len(text), SUBJECT_TARGET)))
    if text.lower().strip(".! ") in VAGUE:
        errors.append(("subject-vague", "subject {!r} does not say what changed".format(text)))
    if text.endswith((".", "!")):
        errors.append(("subject-full-stop", "subject must not end with punctuation"))
    if text[:1].isupper() and not text.split(" ")[0].isupper():
        errors.append(("subject-case", "start the subject with a lower-case imperative verb"))

    if len(lines) < 2 or lines[1]:
        errors.append(("body-leading-blank", "leave one blank line after the header"))
    blocks = paragraphs(lines[1:])
    footer = blocks.pop() if blocks and is_trailer_block(blocks[-1]) else []
    body = [line for block in blocks for line in block]

    if sum(len(line) for line in body) < BODY_MIN_CHARS:
        errors.append(("body-empty", "add a body of at least one full sentence explaining what changed and why"))
    elif text and " ".join(body).strip(". ").lower() == text.lower():
        errors.append(("body-repeats-subject", "the body must add context, not repeat the subject"))
    if len(body) > BODY_LINES_MAX:
        warnings.append(("body-max-lines", "body has {} lines; split the commit or move detail to the PR".format(len(body))))
    for line in body:
        if "://" in line:
            continue
        if len(line) > BODY_LINE_MAX:
            errors.append(("body-max-line-length", "wrap body lines; found one with {} characters".format(len(line))))
            break
        if len(line) > BODY_WRAP:
            warnings.append(("body-wrap", "wrap body lines at {} characters".format(BODY_WRAP)))
            break

    if not footer:
        errors.append(("footer-missing", "end with a trailer block: Breaking, optional Refs, and Co-Authored-By"))
        return errors, warnings
    keys = [TRAILER.match(line).group("key") for line in footer if TRAILER.match(line)]
    values = {}
    for line in footer:
        found = TRAILER.match(line)
        if found:
            values.setdefault(found.group("key"), []).append(found.group("value"))
    if "BREAKING CHANGE" in keys:
        errors.append(("breaking-token", "write BREAKING-CHANGE (hyphen); the spaced form hides git trailers"))
    breaking = values.get("BREAKING-CHANGE", []) + values.get("BREAKING CHANGE", [])
    declared = values.get("Breaking", [])
    if bool(breaking) == bool(declared):
        errors.append(("breaking-declared", "declare exactly one of 'Breaking: none' or 'BREAKING-CHANGE: <impact>'"))
    if declared and declared != ["none"]:
        errors.append(("breaking-declared", "the non-breaking form is exactly 'Breaking: none'"))
    detail = _continued(footer, "BREAKING-CHANGE") + _continued(footer, "BREAKING CHANGE")
    if breaking and len(" ".join(detail)) < BREAKING_MIN:
        errors.append(("breaking-detail", "describe what breaks and how to migrate"))
    if bool(bang) != bool(breaking):
        errors.append(("breaking-change-exclamation-mark", "use '!' in the header if and only if a BREAKING-CHANGE trailer exists"))

    co_authors = [line for line in footer if line.lower().startswith("co-authored-by:")]
    if not co_authors and not human:
        errors.append(("co-author", "AI-assisted commits need the repository's Co-Authored-By trailer"))
    if co_authors:
        for line in co_authors:
            if not CO_AUTHOR.match(line):
                errors.append(("co-author-pattern", "use 'Co-Authored-By: Name <email>' with this exact key casing"))
                break
        if trailer:
            email = trailer.rsplit("<", 1)[-1]
            if any(line != trailer and line.endswith("<" + email) for line in co_authors):
                errors.append(("co-author-pattern", "the agent appears under a varied trailer; use: {}".format(trailer)))
            elif trailer not in co_authors and not human:
                errors.append(("co-author-pattern", "use the repository trailer exactly: {}".format(trailer)))
        if keys and keys[-1] != "Co-Authored-By":
            warnings.append(("co-author-last", "put Co-Authored-By as the last trailer"))
    return errors, warnings


def _continued(footer, key):
    out, active = [], False
    for line in footer:
        if line.startswith(key + ":"):
            active = True
            out.append(line.split(":", 1)[1].strip())
        elif active and line[:1] in (" ", "\t"):
            out.append(line.strip())
        else:
            active = False
    return out


def read_range(spec):
    result = subprocess.run(
        ["git", "log", "--format=%H%x00%B%x01", spec],
        capture_output=True, text=True, check=False,
    )
    if result.returncode:
        raise SystemExit("git log failed: " + result.stderr.strip())
    commits = []
    for chunk in result.stdout.split("\x01"):
        if "\x00" in chunk:
            sha, body = chunk.split("\x00", 1)
            commits.append((sha.strip()[:7], body))
    return commits


def main(argv=None):
    parser = argparse.ArgumentParser(description="Check commit messages against the Complete Commit Contract.")
    parser.add_argument("source", nargs="?", help="message file, or - for stdin")
    parser.add_argument("--range", dest="rev_range", help="git revision range to check, e.g. main..HEAD")
    parser.add_argument("--trailer", help="exact Co-Authored-By line the repository uses")
    parser.add_argument("--human", action="store_true", help="do not require a co-author trailer; any present must still match")
    parser.add_argument("--types", help="comma-separated allowed types")
    parser.add_argument("--json", action="store_true", help="print JSON")
    args = parser.parse_args(argv)
    if bool(args.source) == bool(args.rev_range):
        parser.print_usage(sys.stderr)
        print("lint-commit.py: give a message file, '-', or --range", file=sys.stderr)
        return 2
    types = tuple(t.strip() for t in args.types.split(",")) if args.types else DEFAULT_TYPES

    if args.rev_range:
        messages = read_range(args.rev_range)
    elif args.source == "-":
        messages = [("stdin", sys.stdin.read())]
    else:
        with open(args.source, encoding="utf-8") as handle:
            messages = [(args.source, handle.read())]

    report, failed = [], False
    for name, message in messages:
        errors, warnings = lint(message, types, args.trailer, args.human)
        failed = failed or bool(errors)
        report.append({"commit": name, "errors": errors, "warnings": warnings})
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        for item in report:
            status = "FAIL" if item["errors"] else "PASS"
            print("{} {}".format(status, item["commit"]))
            for level, entries in (("error", item["errors"]), ("warning", item["warnings"])):
                for rule, text in entries:
                    print("  {} [{}] {}".format(level, rule, text))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
