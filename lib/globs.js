const fs = require('fs')
const path = require('path')

/**
 * Expand single-level brace groups: {a,b,c} → (?:a|b|c)
 */
function expandBraces (glob) {
  return glob.replace(/\{([^{}]+)\}/g, (_, contents) => {
    return '(?:' + contents.split(',').join('|') + ')'
  })
}

function globToRegex (glob) {
  // Expand braces into placeholders before escaping
  const altGroups = []
  const expanded = expandBraces(glob).replace(/\(\?:([^)]+)\)/g, (_, alts) => {
    altGroups.push(alts)
    return `{{ALT${altGroups.length - 1}}}`
  })
  let pattern = expanded.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  pattern = pattern.replace(/\*\*\//g, '{{DIRSTAR}}')
  pattern = pattern.replace(/\*\*/g, '{{GLOBSTAR}}')
  pattern = pattern.replace(/\*/g, '[^/]*')
  pattern = pattern.replace(/\?/g, '.')
  pattern = pattern.replace(/\{\{DIRSTAR\}\}/g, '(.*/)?')
  pattern = pattern.replace(/\{\{GLOBSTAR\}\}/g, '.*')
  // Restore alternation groups
  for (let i = 0; i < altGroups.length; i++) {
    const escaped = altGroups[i].split('|').map(a => a.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('|')
    pattern = pattern.replace(`\\{\\{ALT${i}\\}\\}`, `(?:${escaped})`)
  }
  return new RegExp('^' + pattern + '$')
}

function walkDir (baseDir, currentDir, pattern, files) {
  let entries
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name)
    const relativePath = path.relative(baseDir, fullPath)

    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      walkDir(baseDir, fullPath, pattern, files)
    } else if (entry.isFile() && pattern.test(relativePath)) {
      files.add(relativePath)
    }
  }
}

function matchesGlobList (relativePath, globs) {
  let matched = false
  for (const glob of globs) {
    const negated = glob.startsWith('!')
    const pattern = negated ? glob.slice(1) : glob
    if (globToRegex(pattern).test(relativePath)) {
      matched = !negated
    }
  }
  return matched
}

function expandGlobs (rootDir, globs) {
  const hasNegation = globs.some(g => g.startsWith('!'))

  if (!hasNegation) {
    const files = new Set()
    for (const glob of globs) {
      walkDir(rootDir, rootDir, globToRegex(glob), files)
    }
    return Array.from(files)
  }

  // Slow path: walk once with inclusion patterns, then filter through matchesGlobList
  const inclusions = globs.filter(g => !g.startsWith('!'))
  const candidates = new Set()
  for (const glob of inclusions) {
    walkDir(rootDir, rootDir, globToRegex(glob), candidates)
  }
  return Array.from(candidates).filter(f => matchesGlobList(f, globs))
}

/**
 * Check if a file path matches any of the configured source globs.
 * If no sources configured, all files are considered source files.
 */
function isSourceFile (filePath, rootDir, sources) {
  if (!sources || sources.length === 0) return true

  let relativePath
  if (path.isAbsolute(filePath)) {
    relativePath = path.relative(rootDir, filePath)
  } else {
    relativePath = filePath
  }

  if (relativePath.startsWith('..')) return false

  return matchesGlobList(relativePath, sources)
}

/**
 * Check if a file path matches any of the configured test globs.
 * Returns false if no tests configured.
 */
function isTestFile (filePath, rootDir, tests) {
  if (!tests || tests.length === 0) return false

  let relativePath
  if (path.isAbsolute(filePath)) {
    relativePath = path.relative(rootDir, filePath)
  } else {
    relativePath = filePath
  }

  if (relativePath.startsWith('..')) return false

  return matchesGlobList(relativePath, tests)
}

/**
 * Best-effort realpath. Falls back to resolving the parent directory when the
 * file itself does not exist yet, so a path can still be normalized past a
 * symlinked ancestor (/tmp -> /private/tmp on macOS).
 */
function bestEffortRealpath (filePath) {
  try {
    return fs.realpathSync(filePath)
  } catch {
    try {
      const dir = fs.realpathSync(path.dirname(filePath))
      return path.join(dir, path.basename(filePath))
    } catch {
      return filePath
    }
  }
}

/**
 * Resolve a file path to a relative path from the root dir.
 * Shared by sourceFilesEdited and testFilesEdited.
 */
function resolveRelativePath (filePath, rootDir) {
  if (!filePath) return null
  let resolvedRoot = rootDir
  try { resolvedRoot = fs.realpathSync(rootDir) } catch {}
  let resolvedFile = filePath
  if (path.isAbsolute(filePath)) {
    resolvedFile = bestEffortRealpath(filePath)
  }
  const relativePath = path.isAbsolute(resolvedFile)
    ? path.relative(resolvedRoot, resolvedFile)
    : filePath
  if (relativePath.startsWith('..')) return null
  return relativePath
}

/**
 * True when `rel` (the output of path.relative) stays inside its base.
 *
 * Uses path segments rather than a string prefix: a sibling directory such as
 * `../project-other` escapes, but a file legitimately named `..foo` does not.
 */
function isContainedRelative (rel) {
  if (rel === '' || rel === '..') return false
  if (path.isAbsolute(rel)) return false
  return !rel.startsWith('..' + path.sep)
}

/**
 * Resolve a tracked path to a normalized path relative to `rootDir`, or null
 * if it escapes the root.
 *
 * Unlike resolveRelativePath, a relative input is first anchored to `baseDir`
 * and then normalized, so `docs/../../elsewhere` cannot slip through the way it
 * does when a relative path is passed along untouched. Containment here is
 * always enforced and never depends on source globs.
 *
 * Precondition: realpath cannot resolve components that do not exist, so a path
 * whose parent directory is also missing is compared lexically. A path several
 * missing components below a symlink pointing out of the project will therefore
 * be reported as contained. Callers that may see such paths must establish that
 * the file exists first — an existing file always resolves, because its parents
 * necessarily exist. session_diff relies on that; a new caller must check.
 *
 * @param {string} filePath - path as recorded (relative to baseDir, or absolute)
 * @param {string} rootDir  - directory the result is made relative to
 * @param {string} [baseDir] - anchor for relative inputs (defaults to rootDir)
 */
function resolveContainedPath (filePath, rootDir, baseDir) {
  if (!filePath || !rootDir) return null
  const anchor = baseDir || rootDir
  const absolute = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(anchor, filePath)
  const resolvedFile = bestEffortRealpath(absolute)
  const resolvedRoot = bestEffortRealpath(rootDir)
  const rel = path.relative(resolvedRoot, resolvedFile)
  return isContainedRelative(rel) ? rel : null
}

function isProveItConfigPath (filePath) {
  if (!filePath) return false
  if (/prove_it(\.local)?\.json/.test(filePath)) return true
  if (/prove_it\/config(\.local)?\.json/.test(filePath)) return true
  return false
}

function isLocalConfigWrite (command) {
  const cmd = command || ''
  const configPat = 'prove_it(\\.local)?\\.json|prove_it/config(\\.local)?\\.json'
  return new RegExp(`>\\s*\\S*(${configPat})|tee\\s+.*(${configPat})`).test(cmd)
}

function isConfigFileEdit (toolName, toolInput) {
  if (toolName !== 'Write' && toolName !== 'Edit') return false
  return isProveItConfigPath(toolInput?.file_path || '')
}

module.exports = {
  expandBraces,
  globToRegex,
  matchesGlobList,
  walkDir,
  expandGlobs,
  isSourceFile,
  isTestFile,
  bestEffortRealpath,
  resolveRelativePath,
  isContainedRelative,
  resolveContainedPath,
  isProveItConfigPath,
  isLocalConfigWrite,
  isConfigFileEdit
}
