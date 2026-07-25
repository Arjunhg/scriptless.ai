const NUMERIC_UNION_ALIASES = new Set([
  "count",
  "number",
  "repo_id",
  "total_count",
]);

function replaceOutsideSingleQuotes(
  sql: string,
  replace: (segment: string) => string
): string {
  const parts: string[] = [];
  let segmentStart = 0;
  let index = 0;

  while (index < sql.length) {
    if (sql[index] !== "'") {
      index += 1;
      continue;
    }

    if (index > segmentStart) {
      parts.push(replace(sql.slice(segmentStart, index)));
    }

    const quoteStart = index;
    index += 1;
    while (index < sql.length) {
      if (sql[index] !== "'") {
        index += 1;
        continue;
      }

      if (sql[index + 1] === "'") {
        index += 2;
        continue;
      }

      index += 1;
      break;
    }

    parts.push(sql.slice(quoteStart, index));
    segmentStart = index;
  }

  if (segmentStart < sql.length) {
    parts.push(replace(sql.slice(segmentStart)));
  }

  return parts.join("");
}

function splitTopLevelUnionAll(sql: string): string[] {
  const branches: string[] = [];
  let branchStart = 0;
  let parenthesisDepth = 0;
  let index = 0;
  let inString = false;

  while (index < sql.length) {
    const character = sql[index];

    if (inString) {
      if (character === "'") {
        if (sql[index + 1] === "'") {
          index += 2;
          continue;
        }
        inString = false;
      }
      index += 1;
      continue;
    }

    if (character === "'") {
      inString = true;
      index += 1;
      continue;
    }

    if (character === "(") {
      parenthesisDepth += 1;
      index += 1;
      continue;
    }

    if (character === ")") {
      parenthesisDepth = Math.max(0, parenthesisDepth - 1);
      index += 1;
      continue;
    }

    if (parenthesisDepth === 0) {
      const match = sql.slice(index).match(/^UNION\s+ALL\b/i);
      if (match) {
        branches.push(sql.slice(branchStart, index).trim());
        index += match[0].length;
        branchStart = index;
        continue;
      }
    }

    index += 1;
  }

  branches.push(sql.slice(branchStart).trim());
  return branches;
}

function unionLiteralForAlias(alias: string): string {
  const normalizedAlias = alias.replace(/["']/g, "").toLowerCase();
  return NUMERIC_UNION_ALIASES.has(normalizedAlias) ? "0" : "''";
}

function normalizeUnionNulls(branch: string): string {
  return replaceOutsideSingleQuotes(branch, (segment) => {
    const withoutCastNulls = segment.replace(
      /\bCAST\s*\(\s*NULL\s+AS\s+[A-Za-z_][\w]*(?:\s*\([^)]*\))?\s*\)\s+AS\s+([A-Za-z_"][\w"]*)/gi,
      (_match, alias: string) => `${unionLiteralForAlias(alias)} AS ${alias}`
    );

    return withoutCastNulls.replace(
      /\bNULL\s+AS\s+([A-Za-z_"][\w"]*)/gi,
      (_match, alias: string) => `${unionLiteralForAlias(alias)} AS ${alias}`
    );
  });
}

function normalizeGithubSearchBranch(branch: string): string {
  if (!/\bgithub\.search_issues\s*\(/i.test(branch)) {
    return branch;
  }

  return replaceOutsideSingleQuotes(branch, (segment) =>
    segment
      .replace(/\bquery\s*=>/gi, "q =>")
      .replace(/\burl\b/gi, "html_url")
  );
}

export function normalizeCoralSql(sql: string): string {
  const branches = splitTopLevelUnionAll(sql);
  const hasUnionAll = branches.length > 1;

  return branches
    .map((branch) => {
      const normalizedBranch = normalizeGithubSearchBranch(branch);
      return hasUnionAll ? normalizeUnionNulls(normalizedBranch) : normalizedBranch;
    })
    .join(" UNION ALL ");
}