# Project notes

START Hack Munich 2026, Lio challenge. Submission deadline: Sunday 22 Nov 2026, 12:00 Europe/Berlin.

## Rules
- Portal data (`data/`), the challenge PDFs and `.env` must never be committed. The data may not leave the team.
- No supplier email is sent without explicit approval from the team.
- Findings must be derived from the files at runtime. Never copy values from the data into code.

## Commands (run from `backend/`)
- Tests: `uv run pytest -q`
- Sync the portal mirror once: `uv run python -m app.portal` (writes `data/portal`, `data/blobs`, `data/state.sqlite`)
- New dependencies: `uv add <pkg>`; `[tool.uv] exclude-newer` in `pyproject.toml` keeps out releases younger than a week.

## Git
- No global git identity on this machine. Commit with
  `git -c user.name="Hari0m-git" -c user.email="harisankarkaramchand@gmail.com" commit ...`
- Push with `git -c credential.helper= -c credential.helper='!gh auth git-credential' push`
