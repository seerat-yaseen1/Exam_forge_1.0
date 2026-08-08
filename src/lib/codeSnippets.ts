/**
 * CODE SNIPPETS — the boilerplate an author should not be retyping
 *
 * Two jobs, and they are different enough to be worth naming separately.
 *
 * STARTER TEMPLATES are what a candidate opens a coding question into. They
 * exist because an empty editor is a worse question than a stub: it makes
 * every candidate spend their first minutes on the same ceremony — imports,
 * a main, reading stdin — none of which is what the question is testing.
 *
 * STEM SNIPPETS are fenced blocks for Output Prediction and Code Review, where
 * the code IS the question. Those get inserted into the stem, not the editor.
 *
 * The templates are deliberately minimal. A stub that solves half the problem
 * changes what is being assessed, and a stub carrying a comment telling the
 * candidate what to do belongs in the stem where everyone will read it.
 */

import type { AuthoringLanguage } from './codeAuthoring';

/**
 * The fence tag RichText highlights a block with.
 *
 * Not always the platform's own language id — the highlighter knows `python`,
 * not `python3` — so this mapping exists rather than being assumed.
 */
export const FENCE_TAG: Record<AuthoringLanguage, string> = {
  python3: 'python',
  javascript: 'javascript',
  typescript: 'typescript',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  csharp: 'csharp',
  go: 'go',
  rust: 'rust',
  kotlin: 'kotlin',
  php: 'php',
  ruby: 'ruby',
  sql: 'sql',
};

/**
 * A minimal, runnable stub per language.
 *
 * Every one of these compiles and runs as-is, producing no output. That is the
 * point: a candidate's first run should fail on the ANSWER being absent, not
 * on a missing brace in scaffolding they did not write. A template that does
 * not compile teaches them to distrust the starting state.
 */
export const STARTER_TEMPLATES: Record<AuthoringLanguage, string> = {
  python3:
    'import sys\n\n\ndef solve() -> None:\n    data = sys.stdin.read().split()\n    # your code here\n\n\nsolve()\n',
  javascript:
    "const data = require('fs').readFileSync(0, 'utf8').split(/\\s+/);\n\nfunction solve() {\n  // your code here\n}\n\nsolve();\n",
  typescript:
    "const data: string[] = require('fs').readFileSync(0, 'utf8').split(/\\s+/);\n\nfunction solve(): void {\n  // your code here\n}\n\nsolve();\n",
  java:
    'import java.util.*;\n\npublic class Main {\n    public static void main(String[] args) {\n        Scanner in = new Scanner(System.in);\n        // your code here\n    }\n}\n',
  c:
    '#include <stdio.h>\n\nint main(void) {\n    /* your code here */\n    return 0;\n}\n',
  cpp:
    '#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    ios::sync_with_stdio(false);\n    cin.tie(nullptr);\n    // your code here\n    return 0;\n}\n',
  csharp:
    'using System;\n\npublic class Program {\n    public static void Main() {\n        // your code here\n    }\n}\n',
  go:
    'package main\n\nimport (\n\t"bufio"\n\t"fmt"\n\t"os"\n)\n\nfunc main() {\n\treader := bufio.NewReader(os.Stdin)\n\t_ = reader\n\t_ = fmt.Sprint\n\t// your code here\n}\n',
  rust:
    'use std::io::{self, Read};\n\nfn main() {\n    let mut input = String::new();\n    io::stdin().read_to_string(&mut input).unwrap();\n    // your code here\n}\n',
  kotlin:
    'fun main() {\n    val input = generateSequence(::readLine).toList()\n    // your code here\n}\n',
  php:
    '<?php\n$data = trim(file_get_contents("php://stdin"));\n// your code here\n',
  ruby:
    'data = $stdin.read.split\n# your code here\n',
  sql:
    '-- your query here\nSELECT 1;\n',
};

export function starterTemplate(lang: AuthoringLanguage): string {
  return STARTER_TEMPLATES[lang] ?? '';
}

/**
 * Wrap code as a fenced block for a question stem.
 *
 * Trailing newlines are trimmed and exactly one is added before the closing
 * fence: a block whose last line is blank renders with a gap that looks like a
 * mistake, and a block with no trailing newline can swallow the fence itself
 * when an author pastes without one.
 */
export function asFencedBlock(code: string, lang: AuthoringLanguage): string {
  const body = code.replace(/\s+$/, '');
  return `\`\`\`${FENCE_TAG[lang]}\n${body}\n\`\`\``;
}

/**
 * Insert a fenced block into a stem at `cursor`.
 *
 * Blank lines are forced either side. Markdown will not open a fence that
 * begins on the same line as prose, so an author inserting mid-sentence would
 * otherwise get their code rendered inline as literal backticks — which looks
 * like the editor is broken rather than like a formatting rule they broke.
 */
export function insertBlockAt(stem: string, cursor: number, block: string): {
  text: string;
  /** Where the caret should land: after the inserted block. */
  cursor: number;
} {
  const at = Math.max(0, Math.min(cursor, stem.length));
  const before = stem.slice(0, at);
  const after = stem.slice(at);

  const lead = before.length === 0 || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const trail = after.length === 0 || after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';

  const text = `${before}${lead}${block}${trail}${after}`;
  return { text, cursor: before.length + lead.length + block.length };
}

/**
 * Stem snippets — the shapes an Output Prediction or Code Review question
 * tends to be built from.
 *
 * Short on purpose. These are starting points an author edits, not a question
 * bank: a library big enough to pick from without reading is a library that
 * puts the same question in front of every cohort.
 */
export interface StemSnippet {
  id: string;
  label: string;
  /** What it is for, shown beside the label so an author does not have to guess. */
  hint: string;
  language: AuthoringLanguage;
  code: string;
}

export const STEM_SNIPPETS: StemSnippet[] = [
  {
    id: 'py-loop-mutation',
    label: 'Mutating a list while iterating',
    hint: 'Output Prediction — the classic surprising result',
    language: 'python3',
    code: 'xs = [1, 2, 3, 4]\nfor x in xs:\n    if x % 2 == 0:\n        xs.remove(x)\nprint(xs)',
  },
  {
    id: 'py-default-arg',
    label: 'Mutable default argument',
    hint: 'Output Prediction — state that outlives a call',
    language: 'python3',
    code: 'def add(item, bucket=[]):\n    bucket.append(item)\n    return bucket\n\nprint(add(1))\nprint(add(2))',
  },
  {
    id: 'js-hoisting',
    label: 'var hoisting in a loop',
    hint: 'Output Prediction — closure capture',
    language: 'javascript',
    code: 'for (var i = 0; i < 3; i++) {\n  setTimeout(() => console.log(i), 0);\n}',
  },
  {
    id: 'java-string-eq',
    label: 'String identity vs equality',
    hint: 'Output Prediction — == on references',
    language: 'java',
    code: 'String a = "hello";\nString b = new String("hello");\nSystem.out.println(a == b);\nSystem.out.println(a.equals(b));',
  },
  {
    id: 'review-sql-injection',
    label: 'Query built by concatenation',
    hint: 'Code Review — the flaw is the interpolation',
    language: 'python3',
    code: 'def find_user(conn, name):\n    q = "SELECT * FROM users WHERE name = \'" + name + "\'"\n    return conn.execute(q).fetchall()',
  },
  {
    id: 'review-resource-leak',
    label: 'File opened without closing',
    hint: 'Code Review — no context manager, no finally',
    language: 'python3',
    code: 'def read_config(path):\n    f = open(path)\n    data = f.read()\n    return parse(data)',
  },
];

export function snippetsForLanguage(lang?: AuthoringLanguage): StemSnippet[] {
  if (!lang) return STEM_SNIPPETS;
  return STEM_SNIPPETS.filter((s) => s.language === lang);
}
