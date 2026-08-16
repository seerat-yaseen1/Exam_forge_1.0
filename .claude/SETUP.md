# Claude Code skills & plugins

What this repo pins, and what each developer still has to run locally.

## Committed to the repo (no action needed)

### Skills from `emilkowalski/skills`

Installed with the `skills` CLI, which vendors the skill bodies into
`.agents/skills/` and symlinks them into `.claude/skills/` so other agent tools
(Amp, Codex, Cline, Cursor, …) can read the same copies. `skills-lock.json`
pins each skill to a content hash.

| Skill | |
| --- | --- |
| `animate` | build an animation from scratch |
| `animation-vocabulary` | name a motion effect from a description |
| `apple-design` | Apple-style motion, materials, typography |
| `ask-sonner` | Sonner toast library |
| `emil-design-eng` | UI polish and component design philosophy |
| `find-animation-opportunities` | find things that should animate |
| `improve-animations` | audit motion across the codebase |
| `pick-ui-library` | choose a UI library |
| `prototype` | build a prototype |
| `review-animations` | critique existing motion |

To refresh against upstream:

```bash
npx skills@latest add emilkowalski/skills
```

> Note: `.claude/skills/*` are **symlinks**. On Windows, clone with
> `git clone -c core.symlinks=true` (or enable Developer Mode), otherwise they
> land as plain text files containing a path.

### Plugin marketplaces and plugins

`.claude/settings.json` declares three marketplaces and the four plugins below.
Claude Code fetches them on first launch — accept the trust prompt.

| Plugin | Skills |
| --- | --- |
| `example-skills@anthropic-agent-skills` | `frontend-design`, `webapp-testing`, `algorithmic-art`, `brand-guidelines`, `canvas-design`, `doc-coauthoring`, `internal-comms`, `mcp-builder`, `skill-creator`, `slack-gif-creator`, `theme-factory`, `web-artifacts-builder` |
| `document-skills@anthropic-agent-skills` | `docx`, `pdf`, `pptx`, `xlsx` |
| `superpowers@superpowers-marketplace` | `test-driven-development`, `systematic-debugging`, `brainstorming`, `writing-plans`, `executing-plans`, `subagent-driven-development`, `dispatching-parallel-agents`, `requesting-code-review`, `receiving-code-review`, `verification-before-completion`, `using-git-worktrees`, `finishing-a-development-branch`, `using-superpowers`, `writing-skills` |
| `ui-ux-pro-max@ui-ux-pro-max-skill` | `design`, `design-system`, `ui-styling`, `banner-design`, `brand`, `slides`, `ui-ux-pro-max` |

The TDD skill is `test-driven-development` (superpowers ships 14 skills, not ~20).

Combined always-on context cost is roughly **4k tokens** per session
(~1.2k example-skills, ~1.1k ui-ux-pro-max, ~1.0k document-skills, ~0.7k
superpowers). Trim with `claude plugin disable <plugin>` if that matters.

## Run locally once (not committed)

### claude-mem

Deliberately **not** in `.claude/settings.json`: it needs an `npm install` step
that a plain marketplace clone does not perform, so declaring it project-wide
would hand collaborators a plugin whose hooks fail on load. Each developer runs:

```bash
npx claude-mem install
npx claude-mem start     # worker autostart is skipped on non-TTY installs
```

Memory lives in `~/.claude-mem` on that machine, and injection begins on your
**second** session in a project. Dashboard: <http://127.0.0.1:37700>.
Optionally run `/learn-codebase` to ingest the repo up front (~5 min).

If `claude plugin list` reports `claude-mem@thedotmack … cache-miss`, refresh
the marketplace clone:

```bash
claude plugin marketplace update thedotmack
```

## Verifying

```bash
claude plugin list                  # all five plugins, status enabled
claude plugin marketplace list      # four marketplaces
claude plugin details superpowers@superpowers-marketplace
```
