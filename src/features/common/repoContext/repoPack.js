/**
 * Packs a git repository into one text block small enough to attach to every Ask.
 *
 * Two measured numbers set the whole shape (see memory-bank/finding-ttft-vs-prompt-size.md).
 * 19,361 real input tokens measured TTFT p50 1,147 ms / max 1,244 ms, inside the 1.5 s speaking
 * budget; 63,077 tokens measured p50 1,831 ms / max 2,485 ms, outside it. And 185,958 bytes came
 * back as 74,725 input tokens, i.e. 2.49 bytes per token, where the usual bytes/4 would have
 * predicted 46,490: YAML, Helm, shell and SVG all tokenize far worse than prose.
 *
 * The result is a PARTITION: every enumerated path lands in exactly one of `files` or `omitted`,
 * asserted before the pack is returned. A path in neither is a bug, not a skip. `packFile` writes
 * a file's `text` only from a whole buffer, so a half-packed file has no representation.
 */

const path = require('node:path');
const fs = require('node:fs');
const util = require('util');
const execFile = util.promisify(require('child_process').execFile);

/**
 * @typedef {'binary'|'too-large'|'over-budget'|'unreadable'|'sensitive'} OmitReason
 * @typedef {{ path: string, bytes: number, text: string }} PackedFile
 * @typedef {{ path: string, bytes: number|null, reason: OmitReason }} OmittedFile
 * @typedef {{ root: string, builtAt: number, files: PackedFile[], omitted: OmittedFile[],
 *             sourceBytes: number, estTokens: number, text: string }} RepoPack
 */

const DEFAULT_POLICY = {
    budgetTokens: 20000,
    bytesPerToken: 2.5,

    // Far above the budget's 50,000-byte equivalent on purpose: a 52 KB prose doc should be
    // reported `over-budget`, not `too-large`.
    maxFileBytes: 1048576,

    /**
     * First matching pattern gives the band; a path matching nothing lands in a final implicit
     * band holding long-form prose docs and SVG.
     *
     * Source and config lead because `docs/` is 74% of the measured bytes and is what breaks the
     * budget, and because the first mock-interview question drew its answer from
     * slice/platform/admission-policy.yaml comments and slice/verify.sh, not from the docs.
     *
     * A pattern containing `/` matches the full relative path, with `**` meaning any run of
     * segments; otherwise it matches the basename, with `*` meaning any run of non-`/` characters.
     */
    priority: [
        {
            label: 'code-and-config',
            patterns: [
                'Makefile', '*.mk', '*.sh', '*.bash', '*.yaml', '*.yml', '*.json', '*.tpl',
                '*.toml', '*.ini', '*.conf', '*.js', '*.ts', '*.jsx', '*.tsx', '*.py', '*.go',
                '*.rs', '*.rb', '*.java', '*.sql', 'Dockerfile*', 'CODEOWNERS', '.gitignore',
            ],
        },
        { label: 'root-prose', patterns: ['README*'] },
        { label: 'diagram-source', patterns: ['*.mmd', '*.puml'] },
    ],

    /**
     * A NUL byte in the head is NOT sufficient. Measured counterexample: executive-summary.pdf in
     * the target repo is 4,870 bytes of ReportLab output and `buffer.indexOf(0)` returns -1, so a
     * NUL sniff packs it as garbage. latin1 keeps these literals byte-for-byte.
     */
    binaryMagic: [
        Buffer.from('%PDF-', 'latin1'),
        Buffer.from('\x89PNG', 'latin1'),
        Buffer.from('GIF8', 'latin1'),
        Buffer.from('\xFF\xD8\xFF', 'latin1'),
        Buffer.from('PK\x03\x04', 'latin1'),
        Buffer.from('\x7FELF', 'latin1'),
    ],
    // Bounded to the head on purpose: a stray NUL late in an otherwise-readable file should not
    // cost the whole file.
    binarySniffBytes: 8192,

    /**
     * Secrets get a filename denylist plus content markers, not one regex, because the two error
     * directions cost different things: a false positive costs an interview answer, a false
     * negative costs a credential.
     * The rejected design's `API_KEY|SECRET|TOKEN|PRIVATE KEY` followed by `:` or `=` was tested
     * against twelve real secret formats and missed all twelve (a PEM header is followed by `-`),
     * while case-insensitively matching 7 of 131 files in glass's own src/ and matching
     * `automountServiceAccountToken: false` in a hardened pod spec, which holds no secret.
     *
     * `id_*` is the broad one: it also omits ordinary source such as `id_generator.js`. That is the
     * deliberate direction of the trade, since an omission is named in the manifest and a leaked
     * key is not.
     */
    secretFilenames: [
        '.env', '.env.*', '*.pem', '*.key', 'id_rsa', 'id_ed25519', 'id_*', '.npmrc', '.netrc',
        '*.p12', '*.tfstate', '.git-credentials', '*kubeconfig*', 'credentials',
    ],

    // Scanned over the WHOLE buffer, not an 8 KiB head, and case-sensitively: these are literal
    // prefixes of real credential formats, and lowercasing them would start matching prose.
    secretMarkers: ['-----BEGIN', 'AKIA', 'ghp_', 'sk-ant-', 'sk-proj-', 'xoxb-'],

    // Shaped, not keyword-based: `scheme://user:pass@host` in a connection string.
    secretUrlCredential: /:\/\/[^\s/:@]+:[^\s/:@]+@/,

    maxOmittedListed: 50,
};

/** `?` is escaped because `*` is the only wildcard in these patterns. */
function segmentToRegExp(segment) {
    return segment.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '[^/]*');
}

function patternToRegExp(pattern) {
    if (!pattern.includes('/')) return new RegExp(`^${segmentToRegExp(pattern)}$`);
    const segments = pattern.split('/');
    // A `**` segment spans a run of segments INCLUDING NONE, so `docs/**/*.md` has to match
    // `docs/a.md` as well as `docs/x/a.md`.
    const body = segments.map((segment, i) => {
        const last = i === segments.length - 1;
        if (segment === '**') return last ? '.*' : '(?:[^/]+/)*';
        return segmentToRegExp(segment) + (last ? '' : '/');
    }).join('');
    return new RegExp(`^${body}$`);
}

function matchesAny(relPath, patterns) {
    const base = relPath.slice(relPath.lastIndexOf('/') + 1);
    return patterns.some(p => patternToRegExp(p).test(p.includes('/') ? relPath : base));
}

function bandOf(relPath, policy) {
    const index = policy.priority.findIndex(entry => matchesAny(relPath, entry.patterns));
    return index === -1 ? policy.priority.length : index;
}

function isBinary(buffer, policy) {
    if (policy.binaryMagic.some(magic => buffer.subarray(0, magic.length).equals(magic))) return true;
    return buffer.subarray(0, policy.binarySniffBytes).indexOf(0) !== -1;
}

function isSensitive(relPath, buffer, policy) {
    // The `.example` exemption covers the `.env` family and nothing else. Exempting every
    // `*.example` would admit a `my-kubeconfig.example` holding real client-key-data, whose
    // base64 trips none of the markers below.
    const base = relPath.slice(relPath.lastIndexOf('/') + 1);
    const envTemplate = base.startsWith('.env.') && base.endsWith('.example');
    if (!envTemplate && matchesAny(relPath, policy.secretFilenames)) return true;
    const whole = buffer.toString('latin1');
    return policy.secretMarkers.some(marker => whole.includes(marker))
        || policy.secretUrlCredential.test(whole);
}

/**
 * The one constructor: a PackedFile holding the whole buffer, or an OmittedFile holding none of it.
 *
 * @returns {PackedFile|OmittedFile}
 */
function packFile(relPath, buffer, policy) {
    if (isBinary(buffer, policy)) return { path: relPath, bytes: buffer.length, reason: 'binary' };
    if (isSensitive(relPath, buffer, policy)) return { path: relPath, bytes: buffer.length, reason: 'sensitive' };
    return { path: relPath, bytes: buffer.length, text: buffer.toString('utf8') };
}

/** A `.git` file means a worktree and a `.git` directory means a clone; both are real roots. */
async function assertGitRoot(root) {
    try {
        await fs.promises.stat(path.join(root, '.git'));
    } catch {
        throw new Error(`[RepoPack] ${root} has no .git entry, refusing to pack it`);
    }
}

/**
 * One git call, never a filesystem walk. Measured on the glass repo: `git ls-files` returns 229
 * paths where a walk returns 61,328, and the walk's extra entries include `.claude/worktrees/`
 * holding divergent duplicate copies of src/. git also excludes `.git/` for free, which in one
 * measured repo is 68 files and larger than the repo itself.
 */
async function gitLsFiles(root) {
    // The timeout matters because refresh() is single-flight: a git that never returns, on a hung
    // network mount or behind index-lock contention, would otherwise wedge every later refresh
    // behind the same unsettled promise. `ls-files` measured 26-37 ms on this repo's 229 paths,
    // and 32 MiB of buffer is slack for a monorepo listing.
    const { stdout } = await execFile('git', ['-C', root, 'ls-files', '-z'],
        { maxBuffer: 32 * 1024 * 1024, timeout: 10000 });
    return stdout.split('\0').filter(Boolean);
}

/**
 * Opt-in paths come from a settings file, so they are untrusted spellings. Normalizing first means
 * `./slice/verify.sh` dedupes against git's `slice/verify.sh` instead of being packed a second
 * time and double-charged to the budget, and the containment check stops `../../.ssh/known_hosts`
 * being read at all.
 */
function normalizeIncludePaths(root, includePaths) {
    return includePaths.map(entry => {
        const relative = path.relative(root, path.resolve(root, entry));
        if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            throw new Error(`[RepoPack] opt-in path ${entry} resolves outside ${root}`);
        }
        return relative;
    });
}

/**
 * `too-large` is decided from stat before the read, so one pathological file is never loaded into
 * the main process. The catch covers the two I/O calls only: a throw out of
 * packFile is a defect in this module, and reporting it as `unreadable` would turn every file in
 * the repo into a plausible-looking omission instead of failing the build.
 */
async function classifyPath(root, relPath, policy) {
    const absolute = path.join(root, relPath);
    let bytes = null;
    let buffer;
    try {
        bytes = (await fs.promises.stat(absolute)).size;
        if (bytes > policy.maxFileBytes) return { path: relPath, bytes, reason: 'too-large' };
        buffer = await fs.promises.readFile(absolute);
    } catch {
        return { path: relPath, bytes, reason: 'unreadable' };
    }
    return packFile(relPath, buffer, policy);
}

function render(pack, policy) {
    const shown = pack.omitted.slice(0, policy.maxOmittedListed);
    const rest = pack.omitted.length - shown.length;
    const lines = [
        `=== repo: ${path.basename(pack.root)} @ ${new Date(pack.builtAt).toISOString()}`
        + ` (${pack.files.length} files, ${pack.sourceBytes} B, ~${pack.estTokens} tokens) ===`,
        '=== manifest ===',
        ...pack.files.map(file => `INCLUDED ${file.bytes}  ${file.path}`),
        ...shown.map(entry => `OMITTED  ${entry.reason} ${entry.path}`),
    ];
    if (rest > 0) lines.push(`OMITTED  ... and ${rest} more`);

    // The manifest and this list live INSIDE the text so that a named omission produces "that file
    // is not in my context" instead of a confabulated answer about it. Past the cap the names are
    // gone and only the count survives.
    lines.push('=== not included: do not claim knowledge of these files ===');
    if (!pack.omitted.length) lines.push('(none)');
    else {
        lines.push(...shown.map(entry => entry.path));
        if (rest > 0) lines.push(`... and ${rest} more`);
    }

    for (const file of pack.files) lines.push(`=== ${file.path} ===`, file.text);
    return lines.join('\n');
}

/**
 * @param {string} root Absolute path to a git repository or worktree.
 * @param {{ includePaths?: string[], policy?: object }} [options] `includePaths` are relative
 *   paths that `.gitignore` hides and the user wants anyway; the real gap from git was one
 *   nameable file, which justifies an opt-in list rather than a different enumerator.
 * @returns {Promise<RepoPack>}
 */
async function buildRepoPack(root, options = {}) {
    const policy = { ...DEFAULT_POLICY, ...(options.policy || {}) };
    await assertGitRoot(root);

    const optIn = normalizeIncludePaths(root, options.includePaths || []);
    const enumerated = [...new Set([...(await gitLsFiles(root)), ...optIn])];
    const ordered = enumerated
        .map(relPath => ({ relPath, band: bandOf(relPath, policy) }))
        .sort((a, b) => a.band - b.band || (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))
        .map(entry => entry.relPath);

    // Read sequentially. fs.promises runs on the libuv threadpool, default size 4 and
    // UV_THREADPOOL_SIZE unset in this repo, and askService's captureScreenshot awaits
    // fs.promises.readFile on the TTFT critical path, so a parallel burst of reads here would
    // queue that screenshot behind the pack.
    const classified = [];
    for (const relPath of ordered) classified.push(await classifyPath(root, relPath, policy));

    // Classification above ignored the budget, so a binary or sensitive file past the budget
    // crossing point still reports its real reason. Here the first file that would cross the
    // budget and EVERY file after it become over-budget: a hard stop rather than a cherry-pick of
    // whatever still fits, so the result stays deterministic and explainable.
    const budgetBytes = policy.budgetTokens * policy.bytesPerToken;
    const files = [];
    const omitted = [];
    let sourceBytes = 0;
    let crossed = false;
    for (const entry of classified) {
        if (entry.reason) {
            omitted.push(entry);
        } else if (crossed || sourceBytes + entry.bytes > budgetBytes) {
            crossed = true;
            omitted.push({ path: entry.path, bytes: entry.bytes, reason: 'over-budget' });
        } else {
            sourceBytes += entry.bytes;
            files.push(entry);
        }
    }

    const draft = {
        root,
        builtAt: Date.now(),
        files,
        omitted,
        sourceBytes,
        estTokens: Math.round(sourceBytes / policy.bytesPerToken),
    };
    const pack = { ...draft, text: render(draft, policy) };

    // Nothing in the types stops a path producing neither entry, so fail loudly rather than return
    // a short pack that reads as a complete one.
    if (files.length + omitted.length !== ordered.length) {
        throw new Error(`[RepoPack] partition broken: ${files.length} + ${omitted.length}`
            + ` != ${ordered.length} enumerated paths`);
    }
    return pack;
}

module.exports = { buildRepoPack, DEFAULT_POLICY };
