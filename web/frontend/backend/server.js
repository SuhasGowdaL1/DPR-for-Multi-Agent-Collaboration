const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
let jobCounter = 0;

function repoRoot() {
  if (process.env.CFGGEN_REPO_ROOT) {
    return path.resolve(process.env.CFGGEN_REPO_ROOT);
  }
  return path.resolve(__dirname, '../..');
}

function binaryDirectory(root) {
  if (process.env.CFGGEN_BIN_DIR) {
    return path.resolve(process.env.CFGGEN_BIN_DIR);
  }

  for (const candidate of ['build-web', 'build', 'build-linux']) {
    const dir = path.join(root, candidate);
    if (fs.existsSync(path.join(dir, executableName('cfg_generator')))) {
      return dir;
    }
  }

  return path.join(root, 'build-web');
}

function executableName(name) {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

function makeJobId() {
  jobCounter += 1;
  return `${Date.now()}-${jobCounter}`;
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function asArray(value, fallback = []) {
  if (!Array.isArray(value)) {
    return fallback;
  }
  return value.filter((item) => typeof item === 'string' && item.length > 0);
}

function asBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function asInt(value, fallback) {
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function nestedStringArray(object, objectKey, arrayKey) {
  const nested = object?.[objectKey];
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) {
    return [];
  }
  return asArray(nested[arrayKey]);
}

function displayCommand(args) {
  return args
    .map((arg) => {
      if (arg.length > 0 && !/[ \t\n"'\\$]/.test(arg)) {
        return arg;
      }
      return `'${arg.replaceAll("'", "'\\''")}'`;
    })
    .join(' ');
}

function appendOutput(current, chunk) {
  if (current.length >= MAX_LOG_BYTES) {
    return current;
  }
  const next = chunk.toString();
  const remaining = MAX_LOG_BYTES - current.length;
  return current + next.slice(0, remaining);
}

function runProcess(args, workingDirectory) {
  return new Promise((resolve, reject) => {
    if (args.length === 0) {
      reject(new Error('empty command'));
      return;
    }

    let output = '';
    const child = spawn(args[0], args.slice(1), {
      cwd: workingDirectory,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    child.stdout.on('data', (chunk) => {
      output = appendOutput(output, chunk);
    });
    child.stderr.on('data', (chunk) => {
      output = appendOutput(output, chunk);
    });
    child.on('error', (error) => {
      output = appendOutput(output, `${error.message}\n`);
      resolve({ exitCode: error.code === 'ENOENT' ? 127 : 126, output });
    });
    child.on('close', (code, signal) => {
      const exitCode = code ?? (signal ? 128 : 1);
      resolve({ exitCode, output });
    });
  });
}

async function writeFile(filePath, content) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, content);
}

async function fileExists(filePath) {
  try {
    const stats = await fsp.stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

function artifactUrl(jobId, artifact) {
  return `/api/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(artifact)}`;
}

function contentTypeFor(filePath) {
  switch (path.extname(filePath)) {
    case '.json':
      return 'application/json';
    case '.html':
      return 'text/html; charset=utf-8';
    case '.dot':
    case '.log':
    case '.txt':
      return 'text/plain; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

async function collectHtmlArtifacts(jobDir, artifacts, jobId) {
  let files = [];
  try {
    files = await fsp.readdir(jobDir, { withFileTypes: true });
  } catch {
    return;
  }

  const htmlFiles = files
    .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
    .map((entry) => entry.name)
    .sort();

  for (const filename of htmlFiles) {
    if (
      filename === 'runtime-timeline.html' ||
      filename === 'runtime-context-tree.html' ||
      filename === 'callgraph-diff.html'
    ) {
      continue;
    }
    const base = filename.slice(0, -'.html'.length);
    const key = base.replace(/[-_.]+([a-z0-9])/g, (_, char) => char.toUpperCase());
    artifacts[key] = artifactUrl(jobId, filename);
  }
}

async function analyze(request) {
  const start = process.hrtime.bigint();
  const root = repoRoot();
  const bin = binaryDirectory(root);
  const jobId = makeJobId();
  const jobDir = path.join(root, 'out', 'web-jobs', jobId);

  const runtimeLog = asString(request.runtimeLog);
  const entrypoints = asString(request.entrypoints);
  if (!runtimeLog) {
    throw new Error('runtimeLog is required');
  }
  if (!entrypoints) {
    throw new Error('entrypoints is required');
  }

  const sourceRoots = asArray(request.sourceRoots, ['examples']);
  const includeDirs = asArray(request.includeDirs, ['.']);
  const compileFlags = asArray(request.compileFlags);
  const cfgArgs = nestedStringArray(request, 'executableArgs', 'cfg');
  const callgraphArgs = nestedStringArray(request, 'executableArgs', 'callgraph');
  const runtimeArgs = nestedStringArray(request, 'executableArgs', 'runtime');
  const diffArgs = nestedStringArray(request, 'executableArgs', 'diff');

  const logsFile = path.join(jobDir, 'runtime.log');
  const entrypointsFile = path.join(jobDir, 'entrypoints.txt');
  const compileArgsFile = path.join(jobDir, 'compile-args.txt');
  const cfgOutput = path.join(jobDir, 'cfg-analysis.json');
  const callgraphOutput = path.join(jobDir, 'callgraph.json');
  const runtimeOutput = path.join(jobDir, 'runtime-callgraph.json');
  const runtimeDotOutput = path.join(jobDir, 'runtime-callgraph.dot');
  const timelineHtml = path.join(jobDir, 'runtime-timeline.html');
  const contextTreeHtml = path.join(jobDir, 'runtime-context-tree.html');
  const callgraphDiffOutput = path.join(jobDir, 'callgraph-diff.json');
  const callgraphDiffHtml = path.join(jobDir, 'callgraph-diff.html');

  await fsp.mkdir(jobDir, { recursive: true });
  await writeFile(logsFile, runtimeLog);
  await writeFile(entrypointsFile, entrypoints);
  if (compileFlags.length > 0) {
    await writeFile(compileArgsFile, `${compileFlags.join('\n')}\n`);
  }

  const contextDepth = asInt(request.contextDepth, 3);
  const topK = asInt(request.topK, 8);
  const lookahead = asInt(request.lookaheadPlainEvents, 8);
  const emitDot = asBool(request.emitDot, true);
  const emitHtml = asBool(request.emitHtml, true);

  const cfgCommand = [
    path.join(bin, executableName('cfg_generator')),
    '-o',
    cfgOutput
  ];
  for (const includeDir of includeDirs) {
    cfgCommand.push('--include-dir', includeDir);
  }
  if (compileFlags.length > 0) {
    cfgCommand.push('--compile-args-file', compileArgsFile);
  }
  cfgCommand.push(...cfgArgs, ...sourceRoots);

  const callgraphCommand = [
    path.join(bin, executableName('callgraph_generator')),
    '-i',
    cfgOutput,
    '-o',
    callgraphOutput,
    '--context-depth',
    String(contextDepth),
    ...callgraphArgs
  ];

  const runtimeCommand = [
    path.join(bin, executableName('runtime_callgraph_generator')),
    '--logs',
    logsFile,
    '--entrypoints',
    entrypointsFile,
    '--static-callgraph',
    callgraphOutput,
    '--cfg-analysis',
    cfgOutput,
    '-o',
    runtimeOutput,
    '--top-k',
    String(topK),
    '--lookahead-plain-events',
    String(lookahead)
  ];
  if (emitDot) {
    runtimeCommand.push('--dot-output', runtimeDotOutput);
  } else {
    runtimeCommand.push('--no-dot');
  }
  if (emitHtml) {
    runtimeCommand.push('--timeline-html', timelineHtml, '--context-tree-html', contextTreeHtml);
  } else {
    runtimeCommand.push('--no-html');
  }
  runtimeCommand.push(...runtimeArgs);

  const diffCommand = [
    path.join(bin, executableName('callgraph_diff')),
    '--static',
    callgraphOutput,
    '--runtime',
    runtimeOutput,
    '--entrypoints',
    entrypointsFile,
    '-o',
    callgraphDiffOutput
  ];
  if (emitHtml) {
    diffCommand.push('--html', callgraphDiffHtml);
  } else {
    diffCommand.push('--no-html');
  }
  diffCommand.push(...diffArgs);

  const commands = [cfgCommand, callgraphCommand, runtimeCommand, diffCommand];
  let log = '';
  let ok = true;
  let failingExitCode = 0;

  for (const command of commands) {
    log += `$ ${displayCommand(command)}\n`;
    const result = await runProcess(command, root);
    log += result.output;
    if (result.output && !result.output.endsWith('\n')) {
      log += '\n';
    }
    log += `[exit ${result.exitCode}]\n\n`;
    if (result.exitCode !== 0) {
      ok = false;
      failingExitCode = result.exitCode;
      break;
    }
  }

  await writeFile(path.join(jobDir, 'run.log'), log);
  const durationMs = Number((process.hrtime.bigint() - start) / 1000000n);

  const artifacts = {
    runLog: artifactUrl(jobId, 'run.log')
  };
  const appendExisting = async (key, filePath, artifact) => {
    if (await fileExists(filePath)) {
      artifacts[key] = artifactUrl(jobId, artifact);
    }
  };

  await appendExisting('cfgAnalysis', cfgOutput, 'cfg-analysis.json');
  await appendExisting('callgraph', callgraphOutput, 'callgraph.json');
  await appendExisting('runtimeCallgraph', runtimeOutput, 'runtime-callgraph.json');
  await appendExisting('callgraphDiff', callgraphDiffOutput, 'callgraph-diff.json');
  if (emitDot) {
    await appendExisting('runtimeDot', runtimeDotOutput, 'runtime-callgraph.dot');
  }
  if (emitHtml) {
    await appendExisting('timelineHtml', timelineHtml, 'runtime-timeline.html');
    await appendExisting('contextTreeHtml', contextTreeHtml, 'runtime-context-tree.html');
    await appendExisting('callgraphDiffHtml', callgraphDiffHtml, 'callgraph-diff.html');
    await collectHtmlArtifacts(jobDir, artifacts, jobId);
  }

  return {
    body: {
      ok,
      jobId,
      durationMs,
      exitCode: failingExitCode,
      artifacts,
      commands: commands.map(displayCommand),
      log
    },
    statusCode: ok ? 200 : 500
  };
}

function addCorsHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type'
  };
}

function send(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, addCorsHeaders(headers));
  res.end(body);
}

function sendJson(res, statusCode, body) {
  send(res, statusCode, JSON.stringify(body), {
    'Content-Type': 'application/json'
  });
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;

    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('request body is too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function safeArtifactPath(root, jobId, artifact) {
  if (!/^[0-9]+-[0-9]+$/.test(jobId) || !/^[A-Za-z0-9._-]+$/.test(artifact)) {
    return null;
  }
  return path.join(root, 'out', 'web-jobs', jobId, artifact);
}

async function serveArtifact(res, root, pathname) {
  const match = pathname.match(/^\/api\/jobs\/([^/]+)\/artifacts\/([^/]+)$/);
  if (!match) {
    send(res, 404, 'artifact not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }

  const jobId = decodeURIComponent(match[1]);
  const artifact = decodeURIComponent(match[2]);
  const filePath = safeArtifactPath(root, jobId, artifact);
  if (!filePath || !(await fileExists(filePath))) {
    send(res, 404, 'artifact not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }

  send(res, 200, await fsp.readFile(filePath), {
    'Content-Type': contentTypeFor(filePath)
  });
}

async function serveFrontend(res, root, pathname) {
  const dist = path.join(root, 'web', 'frontend', 'dist');
  const requested = pathname === '/' ? '/index.html' : pathname;
  const normalized = path.normalize(decodeURIComponent(requested)).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(dist, normalized);

  if (!filePath.startsWith(dist) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(dist, 'index.html');
  }

  if (!(await fileExists(filePath))) {
    send(res, 404, 'frontend dist not found; run npm run build in web/frontend', {
      'Content-Type': 'text/plain; charset=utf-8'
    });
    return;
  }

  send(res, 200, await fsp.readFile(filePath), {
    'Content-Type': contentTypeFor(filePath)
  });
}

async function route(req, res) {
  const root = repoRoot();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    send(res, 204, '');
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/analyze') {
    try {
      const rawBody = await readRequestBody(req);
      const request = JSON.parse(rawBody);
      const result = await analyze(request);
      sendJson(res, result.statusCode, result.body);
    } catch (error) {
      const statusCode = error.statusCode || (error instanceof SyntaxError ? 400 : 400);
      sendJson(res, statusCode, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/jobs/')) {
    await serveArtifact(res, root, url.pathname);
    return;
  }

  if (req.method === 'GET') {
    await serveFrontend(res, root, url.pathname);
    return;
  }

  send(res, 405, 'method not allowed', { 'Content-Type': 'text/plain; charset=utf-8' });
}

const port = Number(process.argv[2] || process.env.CFGGEN_WEB_PORT || 9001);
const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    sendJson(res, 500, { ok: false, error: error.message });
  });
});

server.on('error', (error) => {
  console.error(`failed to start Node.js backend: ${error.message}`);
  process.exitCode = 1;
});

server.listen(port, '0.0.0.0', () => {
  console.log(`runtime Node.js backend listening on http://localhost:${port}`);
});
